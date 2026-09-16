import { NextRequest, NextResponse } from 'next/server';
import { geminiTryOn } from '@/lib/gemini';
import { altTryOn } from '@/lib/alt-engine';
import { supabase } from '@/lib/supabase';

// 60s timeout — single-call try-on, garment is pre-isolated at upload time.
export const maxDuration = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Locked cost per single try-on call (one AI call @ 512px). The AI engine is
// proprietary and intentionally not named anywhere in the codebase.
const TRYON_COST_USD = 0.045;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const formData = await request.formData();

    const userPhotoFile   = formData.get('user_photo')        as File | null;
    const productImageUrl = formData.get('product_image_url') as string | null;
    const brandId         = formData.get('brand_id')          as string | null;
    let   productId       = formData.get('product_id')        as string | null;
    let   productName     = formData.get('product_name')      as string | null;
    // Catalog browse path: the scan page can hand off by product_uuid (the
    // products.id PK) when a shopper tries on an item from the "More from
    // {Brand}" grid. We resolve its SKU (= product_garments.product_id) and
    // name below, so the rest of the flow is identical to the QR path.
    const productUuid     = formData.get('product_uuid')      as string | null;
    // Model + output resolution are LOCKED server-side (max dim 512). Any
    // model/provider/resolution fields sent by the client are ignored — the
    // AI engine is never selectable from, or exposed to, the client.

    // ── Scan & Wear context (optional) ──────────────────────────────────────
    const sourceParam = (formData.get('source') as string | null)?.trim() || 'ghost-layer';
    const source: 'ghost-layer' | 'scan-wear' | 'digital-mirror' =
      sourceParam === 'scan-wear' || sourceParam === 'digital-mirror' ? sourceParam : 'ghost-layer';
    const qrId       = formData.get('qr_id')        as string | null;
    const passcodeId = formData.get('passcode_id')  as string | null;
    const customerEmail = (formData.get('customer_email') as string | null)?.trim().toLowerCase() || '';
    const customerName = (formData.get('customer_name') as string | null)?.trim() || '';
    const customerPhone = (formData.get('customer_phone') as string | null)?.trim() || '';
    const followupConsent = formData.get('followup_consent') === 'true';
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail);

    // ── Validation ──────────────────────────────────────────────────────────
    if (!userPhotoFile)   return NextResponse.json({ error: 'user_photo is required' },        { status: 400 });
    if (!brandId)         return NextResponse.json({ error: 'brand_id is required' },          { status: 400 });
    if (source === 'scan-wear' && !passcodeId && !emailValid) {
      return NextResponse.json({ error: 'A valid email address is required for free try-ons', code: 'EMAIL_REQUIRED' }, { status: 400 });
    }
    if (source === 'scan-wear' && !passcodeId && customerName.length < 2) {
      return NextResponse.json({ error: 'Your full name is required for free try-ons', code: 'NAME_REQUIRED' }, { status: 400 });
    }
    if (source === 'scan-wear' && !passcodeId && customerPhone.replace(/\D/g, '').length < 7) {
      return NextResponse.json({ error: 'A valid WhatsApp or phone number is required for free try-ons', code: 'PHONE_REQUIRED' }, { status: 400 });
    }
    if (source === 'scan-wear' && !passcodeId && !followupConsent) {
      return NextResponse.json({ error: 'Consent is required before starting a free try-on', code: 'CONSENT_REQUIRED' }, { status: 400 });
    }
    if (customerEmail && !emailValid) {
      return NextResponse.json({ error: 'Please enter a valid email address', code: 'EMAIL_INVALID' }, { status: 400 });
    }

    // ── Resolve product from product_uuid (catalog browse handoff) ─────────
    // When the scan page hands off a catalog item by its products.id, fill in
    // the SKU + name from that row so the cached-garment lookup below (which
    // keys on the SKU) works exactly as it does for the QR flow. product_id
    // and product_name from the form win if already supplied.
    if (productUuid && (!productId || !productName)) {
      const { data: prod } = await supabase
        .from('products')
        .select('sku, name, brand_id, active, show_in_catalog')
        .eq('id', productUuid)
        .maybeSingle();
      if (!prod || prod.brand_id !== brandId) {
        return NextResponse.json({ error: 'Product not found' }, { status: 404 });
      }
      // Only catalog-visible products are try-on-able via this public path.
      if (prod.active === false || prod.show_in_catalog === false) {
        return NextResponse.json({ error: 'This product is not available to try on.' }, { status: 403 });
      }
      productId   = productId   || prod.sku;
      productName = productName || prod.name;
    }

    // product_image_url is only used as a fallback display ref and isn't
    // required once we have a product_id (the garment is loaded from cache).
    if (!productImageUrl && !productId) {
      return NextResponse.json({ error: 'product_image_url is required' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(userPhotoFile.type)) {
      return NextResponse.json({ error: 'Photo must be JPG, PNG, or WebP' }, { status: 400 });
    }
    if (userPhotoFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Photo must be under 10MB' }, { status: 400 });
    }

    // ── Quota pre-check: brand must be admin-approved + have credits ───────
    const { data: brandQuota } = await supabase
      .from('brands')
      .select('status, price_per_tryon_usd, tryon_credits, tryon_credits_used, unlimited, tryon_model_override')
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

    // Engine selection. Brands with tryon_model_override = NULL (i.e. every
    // brand by default) use the locked default engine. 'alt' opts a single
    // brand into the alternate engine for temporary quality evaluation.
    const useAltEngine = brandQuota.tryon_model_override === 'alt';
    if (useAltEngine) console.log(`[try-on] Brand ${brandId} is on the alternate engine.`);

    const engineResult = useAltEngine
      ? await altTryOn(userPhotoBase64, userPhotoFile.type, garment)
      : await geminiTryOn(userPhotoBase64, userPhotoFile.type, garment);

    const resultBase64 = engineResult.data;
    const resultMimeType = engineResult.mimeType;

    // Record the engine that actually ran, so per-model quality and cost can
    // be compared from the tryons table.
    const aiModel = engineResult.model;
    console.log('[try-on] Done.');

    // ── Upload result to Google Cloud Storage ───────────────────────────────
    // Customer photos and generated images are ephemeral: return the result
    // directly to this browser session and never upload it to cloud storage.
    const resultUrl = `data:${resultMimeType};base64,${resultBase64}`;

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
        // Catalog-browse try-ons carry the product's uuid but no QR, so the
        // Scan & Wear block below never runs and previously left this null.
        // Set it up front; the QR path overwrites it with the QR's own
        // product_uuid, which is the same row.
        product_uuid:       productUuid || null,
        result_image_url:   null,
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

      // Write a credit_ledger row for deep analytics using the brand's configured rate.
      // (or whatever the brand's price_per_tryon_usd is set to).
      await supabase.from('credit_ledger').insert({
        brand_id:   brandId,
        product_id: productId,
        qr_id:      qrId,
        tryon_id:   tryonId,
        kind:       'tryon',
        amount:     1,
        cost_usd:   Number(brandQuota.price_per_tryon_usd) || 0.25,
        notes:      `Try-on (${source})`,
      });
    }

    // ── Scan & Wear: bump counters + log scan + link tryon to passcode ─────
    if (source === 'scan-wear' && qrId) {
      try {
        // Atomically consume the successful QR/passcode use. The database
        // also returns an exhausted open QR to passcode-required mode.
        const { data: qr } = await supabase
          .from('qr_codes')
          .select('product_uuid')
          .eq('id', qrId)
          .single();
        const { data: consumedAccess, error: consumeError } = await supabase.rpc('consume_qr_tryon', {
          p_qr_id: qrId,
          p_passcode_id: passcodeId || null,
        });
        if (consumeError) throw consumeError;

        // Do not allow a successful passcode try-on to be returned while its
        // usage counter silently remains unchanged. This catches a missing or
        // stale database function immediately in deployment logs.
        if (passcodeId) {
          const consumed = Array.isArray(consumedAccess) ? consumedAccess[0] : consumedAccess;
          if (!consumed || typeof consumed.passcode_used !== 'number') {
            throw new Error('Passcode usage was not recorded by consume_qr_tryon');
          }
        }

        // Increment brand passcode used_count + link tryon to passcode/product
        if (passcodeId) {
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
        // Swallowed so a bookkeeping failure never costs the customer their
        // try-on, but log loudly with the ids: a silent failure here is why
        // passcode counters and qr_scans can silently stop recording.
        console.error(
          `[try-on] Scan & Wear bookkeeping FAILED qr=${qrId} passcode=${passcodeId ?? 'none'} tryon=${tryonId ?? 'none'}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Save customer contact only after a successful try-on. Email is required
    // for free/open access and optional when a valid passcode was used.
    if (source === 'scan-wear' && customerEmail) {
      const { error: leadError } = await supabase.from('customer_tryon_leads').insert({
        brand_id: brandId,
        qr_id: qrId || null,
        tryon_id: tryonId,
        product_id: productId,
        customer_name: customerName || null,
        customer_email: customerEmail,
        customer_phone: customerPhone || null,
        followup_consent: followupConsent,
        access_mode: passcodeId ? 'passcode' : 'free',
      });
      if (leadError) console.error('[try-on] Failed to save customer lead:', leadError.message);
    }

    // NOTE: never return the AI model/provider to the client — it's secret.
    return NextResponse.json({
      result_url:         resultUrl,
      processing_time_ms: processingTimeMs,
    });

  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    // Log the raw error server-side only. Do NOT echo it to the client — the
    // underlying AI provider/model is secret and raw errors can leak it.
    console.error('[try-on] Unhandled error:', msg, error);
    return NextResponse.json(
      {
        error: 'Something went wrong generating your try-on. Please try again.',
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
