import { NextRequest, NextResponse } from 'next/server';
import { virtualTryOn, geminiTryOn, TRYON_MODEL_PRIMARY, TRYON_MODEL_FALLBACK } from '@/lib/gemini';
import { uploadTryOnResult, uploadIsolatedGarment } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

// 90s timeout — Virtual Try-On API can take up to ~60s
export const maxDuration = 90;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// ── IP Rate Limiting ─────────────────────────────────────────────────────────
// Max 10 try-ons per IP per hour. Module-level — works within a warm Vercel instance.
const ipTimestamps = new Map<string, number[]>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const times = (ipTimestamps.get(ip) ?? []).filter((t) => t > cutoff);
  if (times.length >= RATE_LIMIT_MAX) return false;
  times.push(now);
  ipTimestamps.set(ip, times);
  return true;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // ── Rate limit by IP ────────────────────────────────────────────────────────
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  if (!checkRateLimit(clientIp)) {
    return NextResponse.json(
      { error: 'Too many try-ons. Please wait a bit before trying again.' },
      { status: 429 }
    );
  }

  try {
    const formData = await request.formData();

    const userPhotoFile   = formData.get('user_photo')        as File | null;
    const productImageUrl = formData.get('product_image_url') as string | null;
    const brandId         = formData.get('brand_id')          as string | null;
    const productId       = formData.get('product_id')        as string | null;
    const productName     = formData.get('product_name')      as string | null;
    const provider        = formData.get('provider')          as string | null;
    const geminiModel     = formData.get('gemini_model')      as string | null;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!userPhotoFile)   return NextResponse.json({ error: 'user_photo is required' },        { status: 400 });
    if (!productImageUrl) return NextResponse.json({ error: 'product_image_url is required' }, { status: 400 });
    if (!brandId)         return NextResponse.json({ error: 'brand_id is required' },          { status: 400 });
    if (!ALLOWED_TYPES.includes(userPhotoFile.type)) {
      return NextResponse.json({ error: 'Photo must be JPG, PNG, or WebP' }, { status: 400 });
    }
    if (userPhotoFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Photo must be under 10MB' }, { status: 400 });
    }

    // ── Convert user photo to base64 ────────────────────────────────────────
    const userPhotoBuffer = Buffer.from(await userPhotoFile.arrayBuffer());
    const userPhotoBase64 = userPhotoBuffer.toString('base64');

    // ── Fetch and convert product image ────────────────────────────────────
    const productResponse = await fetch(productImageUrl, {
      headers: { 'User-Agent': 'TryInstantFit/1.0' },
    });
    if (!productResponse.ok) {
      return NextResponse.json({ error: 'Could not fetch product image. Please try again.' }, { status: 400 });
    }
    const productBuffer = Buffer.from(await productResponse.arrayBuffer());
    const productBase64 = productBuffer.toString('base64');

    // ── Call AI model based on provider ────────────────────────────────────
    const useFallback = provider === 'fallback';
    console.log(`[try-on] Using provider: ${useFallback ? 'fallback (Gemini)' : 'primary (Virtual Try-On)'}`);

    let resultBase64: string;
    let resultMimeType: string;
    let isolatedGarmentResult: { data: string; mimeType: string } | undefined;
    let usedGarmentCache = false;
    let usedGeminiModel: string | undefined;

    if (useFallback) {
      const productMimeType = (productResponse.headers.get('content-type') ?? 'image/jpeg').split(';')[0];

      // ── Check for cached isolated garment ──────────────────────────────
      let cachedGarment: { data: string; mimeType: string } | undefined;
      if (productId) {
        const { data: cacheRow } = await supabase
          .from('product_garments')
          .select('isolated_garment_url, mime_type')
          .eq('product_id', productId)
          .eq('brand_id', brandId)
          .single();

        if (cacheRow?.isolated_garment_url) {
          try {
            const resp = await fetch(cacheRow.isolated_garment_url);
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              cachedGarment = { data: buf.toString('base64'), mimeType: cacheRow.mime_type ?? 'image/jpeg' };
              usedGarmentCache = true;
              console.log('[try-on] Cache hit: using cached isolated garment for product:', productId);
            }
          } catch { /* ignore — will re-isolate */ }
        }
      }

      const geminiResult = await geminiTryOn(userPhotoBase64, userPhotoFile.type, productBase64, productMimeType, cachedGarment, geminiModel ?? undefined);
      resultBase64 = geminiResult.data;
      resultMimeType = geminiResult.mimeType;
      isolatedGarmentResult = geminiResult.isolatedGarment;
      usedGeminiModel = geminiResult.model;
    } else {
      const vtResult = await virtualTryOn(userPhotoBase64, productBase64);
      resultBase64 = vtResult.data;
      resultMimeType = vtResult.mimeType;
    }

    const aiModel = useFallback ? (usedGeminiModel ?? TRYON_MODEL_FALLBACK) : TRYON_MODEL_PRIMARY;
    console.log('[try-on] Done.');

    // ── Upload result to Google Cloud Storage ───────────────────────────────
    const resultBuffer = Buffer.from(resultBase64, 'base64');
    const resultUrl = await uploadTryOnResult(resultBuffer, brandId, resultMimeType);

    const processingTimeMs = Date.now() - startTime;

    // ── Cache isolated garment (fire-and-forget) ────────────────────────────
    if (isolatedGarmentResult && productId) {
      (async () => {
        try {
          const garmentBuffer = Buffer.from(isolatedGarmentResult!.data, 'base64');
          const garmentUrl = await uploadIsolatedGarment(garmentBuffer, productId, isolatedGarmentResult!.mimeType);
          await supabase.from('product_garments').upsert({
            product_id:             productId,
            brand_id:               brandId,
            isolated_garment_url:   garmentUrl,
            mime_type:              isolatedGarmentResult!.mimeType,
          }, { onConflict: 'product_id,brand_id' });
          console.log('[try-on] Cached isolated garment for product:', productId);
        } catch (err) {
          console.error('[try-on] Failed to cache garment:', err);
        }
      })();
    }

    // ── Save to Supabase (fire-and-forget) ──────────────────────────────────
    supabase
      .from('tryons')
      .insert({
        brand_id:           brandId,
        product_id:         productId,
        product_name:       productName,
        result_image_url:   resultUrl,
        ai_model:           aiModel,
        processing_time_ms: processingTimeMs,
        cost_usd:           useFallback
          ? (() => {
              const m = usedGeminiModel ?? '';
              if (m.startsWith('imagen-4.0-ultra'))  return 0.06;                            // Imagen 4 Ultra: $0.06 flat
              if (m.startsWith('imagen-4.0-fast'))   return 0.02;                            // Imagen 4 Fast: $0.02 flat
              if (m.startsWith('imagen-4.0'))         return 0.04;                            // Imagen 4 Standard: $0.04 flat
              if (m.includes('pro'))                  return usedGarmentCache ? 0.13 : 0.27; // Pro: $0.134 cached, $0.27 fresh
              return usedGarmentCache ? 0.045 : 0.09;                                        // Flash: $0.045 cached, $0.09 fresh
            })()
          : 0.04,                                                                             // Virtual Try-On: $0.04 flat
        source:             'ghost-layer',
      })
      .then(({ error }) => {
        if (error) console.error('[try-on] Failed to save tryon record:', error.message);
      });

    return NextResponse.json({
      result_url:         resultUrl,
      processing_time_ms: processingTimeMs,
      model:              aiModel,
    });

  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[try-on] Unhandled error:', msg, error);
    return NextResponse.json(
      {
        error: 'Something went wrong generating your try-on. Please try again.',
        debug: msg,
        processing_time_ms: processingTimeMs,
      },
      { status: 500 }
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
