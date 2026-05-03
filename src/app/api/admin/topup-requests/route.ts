import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

/**
 * GET /api/admin/topup-requests
 * List all credit top-up requests with brand info. Filter by ?status=pending|approved|rejected.
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let q = supabase
      .from('credit_topup_requests')
      .select('id, brand_id, amount_usd, amount_local, local_currency, credits_requested, payment_screenshot_url, payment_method, payment_ref, notes, status, reviewed_by, reviewed_at, rejection_reason, created_at')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);

    const { data: topups, error } = await q;
    if (error) throw error;

    // Pull brand info for each
    const brandIds = Array.from(new Set((topups ?? []).map(t => t.brand_id)));
    const brandsById: Record<string, { name: string; email: string; tryon_credits: number; tryon_credits_used: number; status: string }> = {};
    if (brandIds.length > 0) {
      const { data: brands } = await supabase
        .from('brands')
        .select('id, name, email, tryon_credits, tryon_credits_used, status')
        .in('id', brandIds);
      brands?.forEach(b => { brandsById[b.id] = b; });
    }

    return NextResponse.json({
      topups: (topups ?? []).map(t => ({ ...t, brand: brandsById[t.brand_id] || null })),
    }, { status: 200, headers: ADMIN_CORS });
  } catch (e) {
    console.error('[admin/topup-requests GET]', e);
    return NextResponse.json({ error: 'Failed to load topups' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
