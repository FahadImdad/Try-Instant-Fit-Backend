import { NextRequest, NextResponse } from 'next/server';
import { geminiTryOn, TRYON_MODEL_FALLBACK } from '@/lib/gemini';
import { uploadTryOnResult, uploadIsolatedGarment } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

// 90s timeout — Gemini try-on can take up to ~60s for the 2-step flow.
export const maxDuration = 90;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const formData = await request.formData();

    const userPhotoFile   = formData.get('user_photo')        as File | null;
    const productImageUrl = formData.get('product_image_url') as string | null;
    const brandId         = formData.get('brand_id')          as string | null;
    const productId       = formData.get('product_id')        as string | null;
    const productName     = formData.get('product_name')      as string | null;
    const geminiModel        = formData.get('gemini_model')       as string | null;
    const outputResolution   = formData.get('output_resolution')  as string | null;
    // Default 512 (fastest + cheapest). Caller can override per-request.
    const maxDim = outputResolution ? parseInt(outputResolution, 10) : 512;

    // ── Scan & Wear context (optional) ──────────────────────────────────────
    const sourceParam = (formData.get('source') as string | null)?.trim() || 'ghost-layer';
    const source: 'ghost-layer' | 'scan-wear' | 'digital-mirror' =
      sourceParam === 'scan-wear' || sourceParam === 'digital-mirror' ? sourceParam : 'ghost-layer';
    const qrId       = formData.get('qr_id')        as string | null;
    const passcodeId = formData.get('passcode_id')  as string | null;

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

    // ── Quota pre-check: brand must have credits or be unlimited ────────────
    const { data: brandQuota } = await supabase
      .from('brands')
      .select('tryon_credits, tryon_credits_used, unlimited')
      .eq('id', brandId)
      .maybeSingle();

    if (!brandQuota) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
    }

    const remaining = brandQuota.unlimited
      ? null
      : Math.max(0, (brandQuota.tryon_credits || 0) - (brandQuota.tryon_credits_used || 0));

    if (!brandQuota.unlimited && remaining === 0) {
      return NextResponse.json({
        error: 'No try-on credits remaining. Please contact your brand admin to top up.',
        code: 'QUOTA_EXCEEDED',
        credits_total: brandQuota.tryon_credits || 0,
        credits_used: brandQuota.tryon_credits_used || 0,
      }, { status: 402 });
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

    // ── Call Gemini try-on (single path, no fallback) ─────────────────────
    console.log(`[try-on] Using Gemini at ${maxDim}px`);

    const productMimeType = (productResponse.headers.get('content-type') ?? 'image/jpeg').split(';')[0];

    let usedGarmentCache = false;

    // ── Check for cached isolated garment ──────────────────────────────────
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

    const geminiResult = await geminiTryOn(
      userPhotoBase64,
      userPhotoFile.type,
      productBase64,
      productMimeType,
      cachedGarment,
      geminiModel ?? undefined,
      maxDim
    );
    const resultBase64 = geminiResult.data;
    const resultMimeType = geminiResult.mimeType;
    const isolatedGarmentResult = geminiResult.isolatedGarment;
    const usedGeminiModel = geminiResult.model;

    const aiModel = usedGeminiModel ?? TRYON_MODEL_FALLBACK;
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

    // ── Save to Supabase ────────────────────────────────────────────────────
    // For Scan & Wear we need the inserted row's id to link in qr_scans, so we await.
    const tryonInsert = await supabase
      .from('tryons')
      .insert({
        brand_id:           brandId,
        product_id:         productId,
        product_name:       productName,
        result_image_url:   resultUrl,
        ai_model:           aiModel,
        processing_time_ms: processingTimeMs,
        cost_usd:           (() => {
          const m = usedGeminiModel ?? '';
          const r = maxDim; // 512 | 1024 | 2048 | 4096
          const perImg = m.includes('pro')
            ? (r <= 512 ? 0.134 : r <= 1024 ? 0.134 : r <= 2048 ? 0.134 : 0.24)
            : m.includes('2.5-flash')
              ? (r <= 512 ? 0.022 : r <= 1024 ? 0.034 : r <= 2048 ? 0.050 : 0.076)
              : (r <= 512 ? 0.045 : r <= 1024 ? 0.067 : r <= 2048 ? 0.101 : 0.151);
          return usedGarmentCache ? perImg : perImg * 2;
        })(),
        source,
      })
      .select('id')
      .single();

    const tryonId = tryonInsert.data?.id ?? null;
    if (tryonInsert.error) console.error('[try-on] Failed to save tryon record:', tryonInsert.error.message);

    // ── Decrement brand credits (only on successful try-on) ────────────────
    if (!brandQuota.unlimited) {
      await supabase
        .from('brands')
        .update({
          tryon_credits_used: (brandQuota.tryon_credits_used || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', brandId);
    }

    // ── Scan & Wear: bump counters + log scan + link tryon to passcode ─────
    if (source === 'scan-wear' && qrId) {
      try {
        // Increment qr_codes.total_used + grab product_uuid for the tryon link
        const { data: qr } = await supabase
          .from('qr_codes')
          .select('total_used, product_uuid')
          .eq('id', qrId)
          .single();
        if (qr) {
          await supabase
            .from('qr_codes')
            .update({ total_used: (qr.total_used || 0) + 1 })
            .eq('id', qrId);
        }

        // Increment brand passcode used_count + link tryon to passcode/product
        if (passcodeId) {
          const { data: pc } = await supabase
            .from('brand_passcodes')
            .select('used_count')
            .eq('id', passcodeId)
            .single();
          if (pc) {
            await supabase
              .from('brand_passcodes')
              .update({ used_count: (pc.used_count || 0) + 1 })
              .eq('id', passcodeId);
          }
          // Link the just-inserted tryon back to the passcode for sales reporting
          if (tryonId) {
            await supabase
              .from('tryons')
              .update({
                brand_passcode_id: passcodeId,
                product_uuid: qr?.product_uuid ?? null,
              })
              .eq('id', tryonId);
          }
        } else if (tryonId && qr?.product_uuid) {
          // No passcode but still link product_uuid for analytics
          await supabase
            .from('tryons')
            .update({ product_uuid: qr.product_uuid })
            .eq('id', tryonId);
        }

        // Log scan event
        await supabase.from('qr_scans').insert({
          qr_id: qrId,
          brand_passcode_id: passcodeId || null,
          tryon_id: tryonId,
          status: 'completed',
          completed_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[try-on] Scan & Wear bookkeeping failed:', e instanceof Error ? e.message : String(e));
      }
    }

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
