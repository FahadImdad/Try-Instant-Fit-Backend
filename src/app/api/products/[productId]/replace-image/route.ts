import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { uploadProductImage, uploadIsolatedGarment } from '@/lib/storage';
import { isolateGarment, TRYON_MODEL } from '@/lib/gemini';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// AI isolation can take ~10-30s.
export const maxDuration = 90;

interface RouteParams {
  params: Promise<{ productId: string }>;
}

/**
 * POST /api/products/[productId]/replace-image
 * Replace a product's photo with a newly uploaded image and re-run AI
 * garment isolation. Updates the display image AND the cached isolated
 * garment, so existing QR codes / scan pages automatically point to the
 * new processed garment (they read it from the product row + garment cache).
 *
 * Charges 1 processing credit, exactly like creating a product with an image.
 *
 * multipart/form-data field: image (File, required)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { productId } = await params;

    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Upload the image as multipart/form-data with an "image" field.' },
        { status: 400, headers: CORS },
      );
    }

    const fd = await request.formData();
    const imageFile = fd.get('image') as File | null;
    if (!imageFile || imageFile.size === 0) {
      return NextResponse.json({ error: 'Please choose an image to upload.' }, { status: 400, headers: CORS });
    }
    if (!ALLOWED_TYPES.includes(imageFile.type)) {
      return NextResponse.json({ error: 'Image must be JPG, PNG, or WebP' }, { status: 400, headers: CORS });
    }
    if (imageFile.size > MAX_IMAGE_SIZE) {
      return NextResponse.json({ error: 'Image must be under 10MB' }, { status: 400, headers: CORS });
    }

    // Load the product to get its brand + SKU (SKU is the storage/cache key).
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('id, sku, name, brand_id')
      .eq('id', productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404, headers: CORS });
    }

    // Check the brand is approved + has a credit, mirroring product creation.
    const { data: brand } = await supabase
      .from('brands')
      .select('id, status, price_per_tryon_usd, tryon_credits, tryon_credits_used, unlimited')
      .eq('id', product.brand_id)
      .maybeSingle();
    if (!brand) return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS });

    if (!brand.unlimited && brand.status !== 'active') {
      return NextResponse.json(
        { error: 'Your account is pending admin approval. Image processing will resume once your brand is approved.', code: 'NOT_APPROVED' },
        { status: 403, headers: CORS },
      );
    }
    if (!brand.unlimited) {
      const remaining = (brand.tryon_credits || 0) - (brand.tryon_credits_used || 0);
      if (remaining <= 0) {
        return NextResponse.json(
          { error: 'No credits remaining. Top up to replace this image.', code: 'QUOTA_EXCEEDED' },
          { status: 402, headers: CORS },
        );
      }
    }

    const buf = Buffer.from(await imageFile.arrayBuffer());

    // 1) Upload the new customer-facing display image.
    const imageUrl = await uploadProductImage(buf, product.brand_id, product.sku, imageFile.type);

    // 2) Re-run AI isolation on the new image. If this fails we do NOT
    //    update the product or charge a credit — the old garment stays intact.
    const productBase64 = buf.toString('base64');
    const isolated = await isolateGarment(productBase64, imageFile.type);
    const isolatedBuf = Buffer.from(isolated.data, 'base64');
    const isolatedUrl = await uploadIsolatedGarment(isolatedBuf, product.sku, isolated.mimeType);

    // 3) Update the product row + the legacy garment cache so every read
    //    path (dashboard, scan page, try-on) sees the new images.
    const { data: updated, error: updErr } = await supabase
      .from('products')
      .update({
        image_url: imageUrl,
        isolated_garment_url: isolatedUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', productId)
      .select('*')
      .single();
    if (updErr) throw updErr;

    await supabase.from('product_garments').upsert({
      product_id: product.sku,
      brand_id: product.brand_id,
      isolated_garment_url: isolatedUrl,
      mime_type: isolated.mimeType,
    }, { onConflict: 'product_id,brand_id' });

    // Keep the customer-facing display image on any existing QR rows in sync.
    await supabase
      .from('qr_codes')
      .update({ display_image_url: imageUrl })
      .eq('product_uuid', productId);

    // 4) Charge 1 credit (only after isolation + update both succeeded).
    if (!brand.unlimited) {
      await supabase
        .from('brands')
        .update({
          tryon_credits_used: (brand.tryon_credits_used || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', product.brand_id);

      await supabase.from('tryons').insert({
        brand_id: product.brand_id,
        product_id: product.sku,
        product_name: `[Reprocess] ${product.name}`,
        result_image_url: isolatedUrl,
        ai_model: TRYON_MODEL,
        cost_usd: 0.045,
        source: 'ghost-layer',
        product_uuid: productId,
      });

      await supabase.from('credit_ledger').insert({
        brand_id: product.brand_id,
        product_id: product.sku,
        kind: 'process',
        amount: 1,
        cost_usd: Number(brand.price_per_tryon_usd) || 0.125,
        notes: `Image replacement for ${product.name}`,
      });
    }

    return NextResponse.json(
      { product: updated, image_url: imageUrl, isolated_garment_url: isolatedUrl },
      { status: 200, headers: CORS },
    );
  } catch (e) {
    console.error('[products/[productId]/replace-image POST]', e);
    const msg = e instanceof Error ? e.message : 'Failed to replace the product image';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
