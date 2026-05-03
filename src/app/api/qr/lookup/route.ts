import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

/**
 * GET /api/qr/lookup?token=xxxxxx
 * Public endpoint — returns customer-facing QR info for the scan landing page.
 * Returns 404 if token is invalid, expired, or QR is inactive.
 * Does NOT increment usage counters (that happens in /api/qr/[qrId]/redeem).
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400, headers: QR_CORS });
    }

    const { data: qr, error } = await supabase
      .from('qr_codes')
      .select('id, token, brand_id, product_id, product_name, display_image_url, requires_passcode, total_limit, total_used, expires_at, active')
      .eq('token', token)
      .maybeSingle();

    if (error) throw error;
    if (!qr || !qr.active) {
      return NextResponse.json({ error: 'QR not found or inactive' }, { status: 404, headers: QR_CORS });
    }

    if (qr.expires_at && new Date(qr.expires_at) < new Date()) {
      return NextResponse.json({ error: 'QR has expired' }, { status: 410, headers: QR_CORS });
    }

    if (qr.total_limit !== null && qr.total_used >= qr.total_limit) {
      return NextResponse.json({ error: 'QR has reached its try-on limit' }, { status: 410, headers: QR_CORS });
    }

    // Fetch brand display info
    const { data: brand } = await supabase
      .from('brands')
      .select('name, website_url')
      .eq('id', qr.brand_id)
      .maybeSingle();

    return NextResponse.json(
      {
        qr_id: qr.id,
        brand_id: qr.brand_id,
        product_id: qr.product_id,
        product_name: qr.product_name,
        display_image_url: qr.display_image_url,
        requires_passcode: qr.requires_passcode,
        remaining: qr.total_limit !== null ? Math.max(0, qr.total_limit - qr.total_used) : null,
        brand: brand ? { id: qr.brand_id, ...brand } : null,
      },
      { status: 200, headers: QR_CORS },
    );
  } catch (error) {
    console.error('[qr/lookup] Error:', error);
    return NextResponse.json({ error: 'Failed to look up QR' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
