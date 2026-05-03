import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

interface RouteParams {
  params: Promise<{ qrId: string }>;
}

/**
 * POST /api/qr/[qrId]/redeem
 * Validate that a customer can run a try-on against this QR right now.
 * Optionally validates passcode if QR requires one.
 *
 * Body: { passcode?: string }
 *
 * Returns 200 with { allowed: true, passcode_id?, remaining? } if OK.
 * Returns 403 / 410 with { allowed: false, reason } if not.
 *
 * NOTE: This does NOT decrement counters yet — counters are only decremented
 * after a successful try-on completes (via /api/widget/try-on with source='scan-wear').
 * This is a pre-flight check for the customer-facing scan page.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { qrId } = await params;
    const body = await request.json().catch(() => ({}));
    const { passcode } = body ?? {};

    const { data: qr, error: qrError } = await supabase
      .from('qr_codes')
      .select('id, brand_id, requires_passcode, total_limit, total_used, expires_at, active')
      .eq('id', qrId)
      .maybeSingle();

    if (qrError) throw qrError;
    if (!qr || !qr.active) {
      return NextResponse.json({ allowed: false, reason: 'qr_not_found' }, { status: 404, headers: QR_CORS });
    }

    // Brand-level quota check (so customers don't waste an upload then fail)
    const { data: brandQuota } = await supabase
      .from('brands')
      .select('tryon_credits, tryon_credits_used, unlimited')
      .eq('id', qr.brand_id)
      .maybeSingle();
    if (brandQuota && !brandQuota.unlimited && (brandQuota.tryon_credits_used || 0) >= (brandQuota.tryon_credits || 0)) {
      return NextResponse.json({ allowed: false, reason: 'service_unavailable' }, { status: 503, headers: QR_CORS });
    }
    if (qr.expires_at && new Date(qr.expires_at) < new Date()) {
      return NextResponse.json({ allowed: false, reason: 'qr_expired' }, { status: 410, headers: QR_CORS });
    }
    if (qr.total_limit !== null && qr.total_used >= qr.total_limit) {
      return NextResponse.json({ allowed: false, reason: 'qr_limit_reached' }, { status: 410, headers: QR_CORS });
    }

    // Passcode-gated flow
    if (qr.requires_passcode) {
      if (!passcode?.trim()) {
        return NextResponse.json(
          { allowed: false, reason: 'passcode_required' },
          { status: 403, headers: QR_CORS },
        );
      }

      const { data: pc, error: pcError } = await supabase
        .from('qr_passcodes')
        .select('id, code, use_limit, used_count, expires_at, active')
        .eq('qr_id', qrId)
        .eq('code', passcode.trim().toUpperCase())
        .maybeSingle();

      if (pcError) throw pcError;
      if (!pc || !pc.active) {
        return NextResponse.json({ allowed: false, reason: 'passcode_invalid' }, { status: 403, headers: QR_CORS });
      }
      if (pc.expires_at && new Date(pc.expires_at) < new Date()) {
        return NextResponse.json({ allowed: false, reason: 'passcode_expired' }, { status: 410, headers: QR_CORS });
      }
      if (pc.used_count >= pc.use_limit) {
        return NextResponse.json({ allowed: false, reason: 'passcode_limit_reached' }, { status: 410, headers: QR_CORS });
      }

      return NextResponse.json(
        {
          allowed: true,
          passcode_id: pc.id,
          remaining: pc.use_limit - pc.used_count,
        },
        { status: 200, headers: QR_CORS },
      );
    }

    // Open QR (no passcode required)
    return NextResponse.json(
      {
        allowed: true,
        remaining: qr.total_limit !== null ? qr.total_limit - qr.total_used : null,
      },
      { status: 200, headers: QR_CORS },
    );
  } catch (error) {
    console.error('[qr/redeem] Error:', error);
    return NextResponse.json({ allowed: false, reason: 'server_error' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
