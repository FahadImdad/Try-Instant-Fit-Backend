import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateToken, QR_CORS } from '@/lib/qr';
import { uploadProductImage } from '@/lib/storage';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

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
      // Coerce form values into typed object
      body = {
        brand_id: fd.get('brand_id') as string | null,
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
      product_id,
      product_name,
      display_image_url,
      requires_passcode,
      total_limit,
      expires_at,
    } = body as {
      brand_id?: string;
      product_id?: string;
      product_name?: string;
      display_image_url?: string;
      requires_passcode?: boolean;
      total_limit?: number | null;
      expires_at?: string;
    };

    if (!brand_id || !product_id?.trim() || !product_name?.trim()) {
      return NextResponse.json(
        { error: 'brand_id, product_id, and product_name are required' },
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

    // ── If image file uploaded, validate + push to GCS ──────────────────────
    let finalDisplayUrl: string | null = display_image_url?.trim() || null;
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
      finalDisplayUrl = await uploadProductImage(buf, brand_id, product_id.trim(), imageFile.type);
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
        display_image_url: finalDisplayUrl,
        requires_passcode: !!requires_passcode,
        total_limit: total_limit ?? null,
        expires_at: expires_at || null,
      })
      .select('*')
      .single();

    if (qrError) throw qrError;

    const scanBase = process.env.PUBLIC_SCAN_BASE_URL || 'https://tryinstantfit.vercel.app';
    const scanUrl = `${scanBase}/scan.html?token=${token}`;

    return NextResponse.json(
      { qr, scan_url: scanUrl },
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
