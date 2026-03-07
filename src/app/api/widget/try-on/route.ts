import { NextRequest, NextResponse } from 'next/server';
import { virtualTryOn, geminiTryOn, TRYON_MODEL_PRIMARY, TRYON_MODEL_FALLBACK } from '@/lib/gemini';
import { uploadTryOnResult } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

// 90s timeout — Virtual Try-On API can take up to ~60s
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
    const provider        = formData.get('provider')          as string | null;

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

    const { data: resultBase64, mimeType: resultMimeType } = useFallback
      ? await geminiTryOn(userPhotoBase64, userPhotoFile.type, productBase64, (productResponse.headers.get('content-type') ?? 'image/jpeg').split(';')[0])
      : await virtualTryOn(userPhotoBase64, productBase64);

    const aiModel = useFallback ? TRYON_MODEL_FALLBACK : TRYON_MODEL_PRIMARY;
    console.log('[try-on] Done.');

    // ── Upload result to Google Cloud Storage ───────────────────────────────
    const resultBuffer = Buffer.from(resultBase64, 'base64');
    const resultUrl = await uploadTryOnResult(resultBuffer, brandId, resultMimeType);

    const processingTimeMs = Date.now() - startTime;

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
        cost_usd:           useFallback ? 0.14 : 0.04,
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
