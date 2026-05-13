import { NextRequest, NextResponse } from 'next/server';
import { geminiTryOn, TRYON_MODEL } from '@/lib/gemini';
import { uploadTryOnResult } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

// 60s timeout — single-call try-on, garment is pre-isolated at upload time.
export const maxDuration = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Locked Gemini cost per single try-on call (gemini-3.1-flash-image-preview @ 512px).
const TRYON_COST_USD = 0.045;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const formData = await request.formData();

    const userPhotoFile   = formData.get('user_photo')        as File | null;
    const productImageUrl = formData.get('product_image_url') as string | null;
    const brandId         = formData.get('brand_id')          as string | null;
    const productId       = formData.get('product_id')        as string | null;
    const productName     = formData.get('product_name')      as string | null;
    // Model + output resolution are LOCKED server-side:
    // - model: gemini-3.1-flash-image-preview
    // - max dim: 512
    // Any `output_resolution` or `gemini_model` form fields are ignored.

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

    // ── Quota pre-check: brand must be admin-approved + have credits ───────
    const { data: brandQuota } = await supabase
      .from('brands')
      .select('status, price_per_tryon_usd, tryon_credits, tryon_credits_used, unlimited')
      .eq('id', brandId)
      .maybeSingle();

    if (!brandQuota) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
    }

    // Gate: admin must approve the brand (status='active') before customer
    // try-ons consume credits. Pending / suspended brands get a clear
    // message instead of a silent failure.
    if (!brandQuota.unlimited && brandQuota.status !== 'active') {
      return NextResponse.json({
        error: 'This brand is pending approval. Try-ons will resume once approved.',
        code: 'BRAND_NOT_APPROVED',
      }, { status: 403 });
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

    // ── Require pre-isolated garment (no inline isolation at try-on time) ──
    // Garments are isolated upstream at product upload / QR creation.
    // If the cache row is missing, fail fast — the brand needs to re-upload
    // from the editor instead of paying for an inline isolation here.
    if (!productId) {
      return NextResponse.json({
        error: 'product_id is required for try-on.',
        code: 'PRODUCT_ID_REQUIRED',
      }, { status: 400 });
    }

    const { data: cacheRow } = await supabase
      .from('product_garments')
      .select('isolated_garment_url, mime_type')
      .eq('product_id', productId)
      .eq('brand_id', brandId)
      .single();

    if (!cacheRow?.isolated_garment_url) {
      return NextResponse.json({
        error: 'This product has not been processed yet. Please re-upload its image from the brand editor and try again.',
        code: 'GARMENT_NOT_READY',
      }, { status: 422 });
    }

    let garment: { data: string; mimeType: string };
    try {
      const resp = await fetch(cacheRow.isolated_garment_url);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      garment = { data: buf.toString('base64'), mimeType: cacheRow.mime_type ?? 'image/jpeg' };
    } catch (err) {
      console.error('[try-on] Failed to load cached garment:', err);
      return NextResponse.json({
        error: 'We could not load the processed product image. Please try again in a moment.',
        code: 'GARMENT_FETCH_FAILED',
      }, { status: 502 });
    }

    console.log(`[try-on] Using cached isolated garment (product=${productId})`);

    const geminiResult = await geminiTryOn(
      userPhotoBase64,
      userPhotoFile.type,
      garment,
    );
    const resultBase64 = geminiResult.data;
    const resultMimeType = geminiResult.mimeType;

    const aiModel = TRYON_MODEL;
    console.log('[try-on] Done.');

    // ── Upload result to Google Cloud Storage ───────────────────────────────
    const resultBuffer = Buffer.from(resultBase64, 'base64');
    const resultUrl = await uploadTryOnResult(resultBuffer, brandId, resultMimeType);

    const processingTimeMs = Date.now() - startTime;

    // ── Save to Supabase ────────────────────────────────────────────────────
    // For Scan & Wear we need the inserted row's id to link in qr_scans, so we await.
    // Cost is fixed (locked model + size, single call).
    const tryonInsert = await supabase
      .from('tryons')
      .insert({
        brand_id:           brandId,
        product_id:         productId,
        product_name:       productName,
        result_image_url:   resultUrl,
        ai_model:           aiModel,
        processing_time_ms: processingTimeMs,
        cost_usd:           TRYON_COST_USD,
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

      // Write a credit_ledger row for deep analytics — uniform $0.125/credit
      // (or whatever the brand's price_per_tryon_usd is set to).
      await supabase.from('credit_ledger').insert({
        brand_id:   brandId,
        product_id: productId,
        qr_id:      qrId,
        tryon_id:   tryonId,
        kind:       'tryon',
        amount:     1,
        cost_usd:   Number(brandQuota.price_per_tryon_usd) || 0.125,
        notes:      `Try-on (${source})`,
      });
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
