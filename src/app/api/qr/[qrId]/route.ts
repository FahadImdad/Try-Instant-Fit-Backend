import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

interface RouteParams {
  params: Promise<{ qrId: string }>;
}

/**
 * DELETE /api/qr/[qrId]
 *   By default: soft-deletes (sets active=false). The QR stops working but
 *   row + scans + passcodes are preserved for audit/billing.
 *
 *   Add ?hard=true for permanent delete (cascades to passcodes + scans).
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { qrId } = await params;
    const url = new URL(request.url);
    const hard = url.searchParams.get('hard') === 'true';

    if (hard) {
      const { error } = await supabase.from('qr_codes').delete().eq('id', qrId);
      if (error) throw error;
      return NextResponse.json({ ok: true, deleted: 'hard' }, { status: 200, headers: QR_CORS });
    }

    const { data, error } = await supabase
      .from('qr_codes')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', qrId)
      .select('id, active')
      .single();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: 'QR not found' }, { status: 404, headers: QR_CORS });
    }

    return NextResponse.json({ ok: true, deleted: 'soft', qr: data }, { status: 200, headers: QR_CORS });
  } catch (error) {
    console.error('[qr/[qrId] DELETE] Error:', error);
    return NextResponse.json({ error: 'Failed to delete QR' }, { status: 500, headers: QR_CORS });
  }
}

/**
 * PATCH /api/qr/[qrId]
 *   Toggle active (re-enable a soft-deleted QR), or update small fields.
 *
 *   Body: { active?: boolean, total_limit?: number | null, expires_at?: string | null }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { qrId } = await params;
    const body = await request.json();

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.active === 'boolean') update.active = body.active;
    if (body.total_limit === null || typeof body.total_limit === 'number') update.total_limit = body.total_limit;
    if (body.expires_at === null || typeof body.expires_at === 'string') update.expires_at = body.expires_at;

    const { data, error } = await supabase
      .from('qr_codes')
      .update(update)
      .eq('id', qrId)
      .select('*')
      .single();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: 'QR not found' }, { status: 404, headers: QR_CORS });
    }

    return NextResponse.json({ qr: data }, { status: 200, headers: QR_CORS });
  } catch (error) {
    console.error('[qr/[qrId] PATCH] Error:', error);
    return NextResponse.json({ error: 'Failed to update QR' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...QR_CORS, 'Access-Control-Allow-Methods': 'DELETE,PATCH,OPTIONS' },
  });
}
