import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/topup-requests/[id]
 *   Approve or reject a top-up request.
 *   Body: { action: 'approve' | 'reject', rejection_reason?: string }
 *
 * On approve:
 *   - Status → 'approved'
 *   - Brand's tryon_credits += credits_requested
 *   - Brand's status flipped to 'active' if it was 'pending'
 *   - Logs to brand_credit_topups for audit
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const body = await request.json();
    const { action, rejection_reason } = body ?? {};

    if (!['approve', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400, headers: ADMIN_CORS });
    }

    // Fetch the request
    const { data: req, error: fetchError } = await supabase
      .from('credit_topup_requests')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchError || !req) {
      return NextResponse.json({ error: 'Top-up request not found' }, { status: 404, headers: ADMIN_CORS });
    }
    if (req.status !== 'pending') {
      return NextResponse.json({ error: `Already ${req.status}` }, { status: 409, headers: ADMIN_CORS });
    }

    const reviewedAt = new Date().toISOString();

    if (action === 'reject') {
      const { data, error } = await supabase
        .from('credit_topup_requests')
        .update({
          status: 'rejected',
          rejection_reason: rejection_reason?.trim() || null,
          reviewed_by: 'admin',
          reviewed_at: reviewedAt,
        })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return NextResponse.json({ topup: data }, { status: 200, headers: ADMIN_CORS });
    }

    // Approve: add credits to brand
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .select('tryon_credits, status')
      .eq('id', req.brand_id)
      .single();
    if (brandError || !brand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: ADMIN_CORS });
    }

    const newCredits = (brand.tryon_credits || 0) + req.credits_requested;
    // Flip 'pending' (and legacy 'trial') brands to 'active' on first
    // approved top-up. The 'trial' status has been retired going forward.
    const newStatus = (brand.status === 'pending' || brand.status === 'trial') ? 'active' : brand.status;

    await supabase
      .from('brands')
      .update({
        tryon_credits: newCredits,
        status: newStatus,
        updated_at: reviewedAt,
      })
      .eq('id', req.brand_id);

    // Log to credit topups audit
    await supabase.from('brand_credit_topups').insert({
      brand_id: req.brand_id,
      credits_added: req.credits_requested,
      amount_usd: req.amount_usd,
      payment_ref: req.payment_ref,
      notes: `Approved top-up request ${id}` + (req.notes ? ` · ${req.notes}` : ''),
      added_by: 'admin',
    });

    // Mark request approved
    const { data, error } = await supabase
      .from('credit_topup_requests')
      .update({
        status: 'approved',
        reviewed_by: 'admin',
        reviewed_at: reviewedAt,
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;

    return NextResponse.json({
      topup: data,
      brand_credits: newCredits,
      brand_status: newStatus,
    }, { status: 200, headers: ADMIN_CORS });
  } catch (e) {
    console.error('[admin/topup-requests/[id] POST]', e);
    return NextResponse.json({ error: 'Failed to process top-up' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
