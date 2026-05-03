import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateToken, QR_CORS } from '@/lib/qr';

/**
 * POST /api/qr/generate
 * Brand creates a QR code for a product.
 *
 * Body: {
 *   brand_id: string (UUID, required),
 *   product_id: string (required, your internal SKU),
 *   product_name: string (required, customer-facing),
 *   display_image_url?: string,
 *   requires_passcode?: boolean (default false),
 *   total_limit?: number (optional QR-level cap),
 *   expires_at?: ISO 8601 string,
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      brand_id,
      product_id,
      product_name,
      display_image_url,
      requires_passcode,
      total_limit,
      expires_at,
    } = body ?? {};

    if (!brand_id || !product_id?.trim() || !product_name?.trim()) {
      return NextResponse.json(
        { error: 'brand_id, product_id, and product_name are required' },
        { status: 400, headers: QR_CORS },
      );
    }

    if (total_limit !== undefined && total_limit !== null && (typeof total_limit !== 'number' || total_limit < 0)) {
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
        display_image_url: display_image_url?.trim() || null,
        requires_passcode: !!requires_passcode,
        total_limit: total_limit ?? null,
        expires_at: expires_at || null,
      })
      .select('*')
      .single();

    if (qrError) throw qrError;

    // Construct the public scan URL — frontend will use this to render the QR image
    const scanUrl = `${process.env.PUBLIC_SCAN_BASE_URL || 'https://tryinstantfit.vercel.app/scan'}/${token}`;

    return NextResponse.json(
      {
        qr,
        scan_url: scanUrl,
      },
      { status: 201, headers: QR_CORS },
    );
  } catch (error) {
    console.error('[qr/generate] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate QR code' },
      { status: 500, headers: QR_CORS },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
