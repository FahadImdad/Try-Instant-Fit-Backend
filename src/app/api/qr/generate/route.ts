import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateToken, QR_CORS } from '@/lib/qr';
import { uploadProductImage, uploadIsolatedGarment } from '@/lib/storage';
import { isolateGarment } from '@/lib/gemini';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// 90s — AI garment isolation can take ~10-30s
export const maxDuration = 90;

/**
 * POST /api/qr/generate
 * Brand creates a QR code for a product.
 *
 * Accepts BOTH multipart/form-data (with optional file upload) and JSON.
 *
 * Form/JSON fields:
 *   brand_id          (UUID, required)
 *   product_id        (string, required, your internal SKU)
 *   product_name      (string, required, customer-facing)
 *   display_image     (File, multipart only — uploaded to GCS)
 *   display_image_url (string, optional — used if no file)
 *   requires_passcode (boolean, default false)
 *   total_limit       (number, optional)
 *   expires_at        (ISO 8601 string, optional)
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let body: Record<string, unknown> = {};
    let imageFile: File | null = null;

    if (contentType.includes('multipart/form-data')) {
      const fd = await request.formData();
      imageFile = fd.get('display_image') as File | null;
      body = {
        brand_id: fd.get('brand_id') as string | null,
        product_uuid: fd.get('product_uuid') as string | null,
        product_id: fd.get('product_id') as string | null,
        product_name: fd.get('product_name') as string | null,
        display_image_url: fd.get('display_image_url') as string | null,
        requires_passcode: fd.get('requires_passcode') === 'true' || fd.get('requires_passcode') === '1',
        total_limit: fd.get('total_limit') ? parseInt(fd.get('total_limit') as string, 10) : null,
        expires_at: fd.get('expires_at') as string | null,
      };
    } else {
      body = await request.json();
    }

    const {
      brand_id,
      product_uuid,
      product_id: productIdInput,
      product_name: productNameInput,
      display_image_url,
      requires_passcode,
      total_limit,
      expires_at,
    } = body as {
      brand_id?: string;
      product_uuid?: string;
      product_id?: string;
      product_name?: string;
      display_image_url?: string;
      requires_passcode?: boolean;
      total_limit?: number | null;
      expires_at?: string;
    };

    if (!brand_id) {
      return NextResponse.json({ error: 'brand_id is required' }, { status: 400, headers: QR_CORS });
    }
    if (requires_passcode !== true && (!Number.isInteger(total_limit) || Number(total_limit) < 1)) {
      return NextResponse.json(
        { error: 'A positive try-on cap is required when passcode protection is off' },
        { status: 400, headers: QR_CORS },
      );
    }

    // Resolve product info: either from product_uuid (new flow) or product_id+name (legacy)
    let product_id = productIdInput;
    let product_name = productNameInput;
    let resolvedDisplayUrl = display_image_url;
    let resolvedIsolatedUrl: string | null = null;

    if (product_uuid) {
      const { data: prod } = await supabase
        .from('products')
        .select('sku, name, image_url, isolated_garment_url, brand_id')
        .eq('id', product_uuid)
        .maybeSingle();
      if (!prod) {
        return NextResponse.json({ error: 'Product not found' }, { status: 404, headers: QR_CORS });
      }
      if (prod.brand_id !== brand_id) {
        return NextResponse.json({ error: 'Product belongs to a different brand' }, { status: 403, headers: QR_CORS });
      }
      product_id = prod.sku;
      product_name = prod.name;
      resolvedDisplayUrl = resolvedDisplayUrl || prod.image_url;
      resolvedIsolatedUrl = prod.isolated_garment_url;
    }

    if (!product_id?.trim() || !product_name?.trim()) {
      return NextResponse.json(
        { error: 'product_uuid OR (product_id + product_name) are required' },
        { status: 400, headers: QR_CORS },
      );
    }

    if (total_limit !== undefined && total_limit !== null && (typeof total_limit !== 'number' || total_limit < 0 || Number.isNaN(total_limit))) {
      return NextResponse.json(
        { error: 'total_limit must be a non-negative number' },
        { status: 400, headers: QR_CORS },
      );
    }

    // Verify brand exists
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .select('id, name')
      .eq('id', brand_id)
      .maybeSingle();

    if (brandError) throw brandError;
    if (!brand) {
      return NextResponse.json({ error: 'brand_id not found' }, { status: 404, headers: QR_CORS });
    }

    // ── Image + garment isolation ────────────────────────────────────────
    // The QR is only useful once the garment has been isolated, so we
    // require an isolated_garment_url before inserting the qr_codes row.
    // Three paths can satisfy this requirement:
    //   1) The linked product already has an isolated garment cached.
    //   2) An image file is uploaded with this request — we isolate inline.
    //   3) The product has an image_url but no isolated garment yet
    //      (legacy / failed-on-create) — fetch + isolate from that URL.
    // If all three paths fail, we return an error and do NOT create the
    // QR. The brand can re-upload the image and try again.
    let finalDisplayUrl: string | null = resolvedDisplayUrl?.trim() || null;
    let isolatedGarmentUrl: string | null = resolvedIsolatedUrl;
    let garmentIsolated = !!resolvedIsolatedUrl;

    async function isolateBufferAndStore(buf: Buffer, mimeType: string): Promise<void> {
      const cleanProductId = product_id!.trim();
      const productBase64 = buf.toString('base64');
      const isolated = await isolateGarment(productBase64, mimeType);
      const isolatedBuf = Buffer.from(isolated.data, 'base64');
      isolatedGarmentUrl = await uploadIsolatedGarment(isolatedBuf, cleanProductId, isolated.mimeType);

      await supabase
        .from('product_garments')
        .upsert({
          product_id: cleanProductId,
          brand_id,
          isolated_garment_url: isolatedGarmentUrl,
          mime_type: isolated.mimeType,
        }, { onConflict: 'product_id,brand_id' });

      // Also write back to the products row when this QR is for a product_uuid.
      if (product_uuid) {
        await supabase
          .from('products')
          .update({ isolated_garment_url: isolatedGarmentUrl })
          .eq('id', product_uuid);
      }
      garmentIsolated = true;
    }

    // Path 2: image file uploaded with this request.
    if (imageFile && imageFile.size > 0) {
      if (!ALLOWED_TYPES.includes(imageFile.type)) {
        return NextResponse.json(
          { error: 'Image must be JPG, PNG, or WebP' },
          { status: 400, headers: QR_CORS },
        );
      }
      if (imageFile.size > MAX_IMAGE_SIZE) {
        return NextResponse.json(
          { error: 'Image must be under 10MB' },
          { status: 400, headers: QR_CORS },
        );
      }
      const buf = Buffer.from(await imageFile.arrayBuffer());
      const cleanProductId = product_id.trim();

      // Upload customer-facing display image
      finalDisplayUrl = await uploadProductImage(buf, brand_id, cleanProductId, imageFile.type);

      // Only re-run AI isolation if the product doesn't already have an
      // isolated garment cached. The products POST flow already pays for
      // isolation once per product — re-running it here on every QR
      // regeneration would double-charge the platform's AI bill.
      if (!garmentIsolated) {
        try {
          await isolateBufferAndStore(buf, imageFile.type);
        } catch (e) {
          console.error('[qr/generate] inline isolation failed:', e);
        }
      }
    }

    // Path 3: existing product image — fetch and isolate now if we still
    // don't have a garment URL.
    if (!garmentIsolated && finalDisplayUrl) {
      try {
        const resp = await fetch(finalDisplayUrl);
        if (resp.ok) {
          const fetchedMime = (resp.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
          const fetchedBuf = Buffer.from(await resp.arrayBuffer());
          await isolateBufferAndStore(fetchedBuf, fetchedMime);
        } else {
          console.warn('[qr/generate] could not fetch existing product image:', resp.status);
        }
      } catch (e) {
        console.error('[qr/generate] fallback isolation from URL failed:', e);
      }
    }

    if (!garmentIsolated) {
      return NextResponse.json(
        {
          error: 'Could not process the product image. Please re-upload it from the product editor and try again.',
          code: 'ISOLATION_FAILED',
        },
        { status: 422, headers: QR_CORS },
      );
    }

    // Generate unique token (retry if collision — extremely unlikely with 60 bits)
    let token = generateToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: existing } = await supabase.from('qr_codes').select('id').eq('token', token).maybeSingle();
      if (!existing) break;
      token = generateToken();
    }

    const { data: qr, error: qrError } = await supabase
      .from('qr_codes')
      .insert({
        token,
        brand_id,
        product_id: product_id.trim(),
        product_name: product_name.trim(),
        product_uuid: product_uuid || null,
        display_image_url: finalDisplayUrl,
        requires_passcode: !!requires_passcode,
        total_limit: total_limit ?? null,
        expires_at: expires_at || null,
      })
      .select('*')
      .single();

    if (qrError) throw qrError;

    const scanBase = process.env.PUBLIC_SCAN_BASE_URL || 'https://tryinstantfit.com';
    const scanUrl = `${scanBase}/scan/${token}`;

    // garment_isolated is always true here — the isolation gate above
    // returns 422 before reaching this point if it isn't.
    return NextResponse.json(
      {
        qr,
        scan_url: scanUrl,
        garment_isolated: true,
        isolated_garment_url: isolatedGarmentUrl,
        uploaded_image_url: finalDisplayUrl,
      },
      { status: 201, headers: QR_CORS },
    );
  } catch (error) {
    console.error('[qr/generate] Error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to generate QR code';
    return NextResponse.json(
      { error: msg },
      { status: 500, headers: QR_CORS },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
