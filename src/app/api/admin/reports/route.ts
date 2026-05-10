import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

/**
 * GET /api/admin/reports
 *   List try-on reports, newest first. Optional filters: ?status=pending,
 *   ?type=tryon_bad, ?brand_id=UUID.
 *   Joins brand name for display so the admin queue is self-explanatory.
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const status   = url.searchParams.get('status');
    const type     = url.searchParams.get('type');
    const brandId  = url.searchParams.get('brand_id');

    let q = supabase
      .from('tryon_reports')
      .select(`
        id, brand_id, tryon_id, product_id, qr_id,
        type, rating, reason, message, screenshot_url, result_url, user_photo_url, source,
        status, resolved_by, resolved_at, resolution_note,
        credit_refunded, refund_at, created_at,
        brand:brands ( id, name, email )
      `)
      .order('created_at', { ascending: false })
      .limit(500);

    if (status)  q = q.eq('status', status);
    if (type)    q = q.eq('type', type);
    if (brandId) q = q.eq('brand_id', brandId);

    const { data, error } = await q;
    if (error) throw error;

    return NextResponse.json({ reports: data ?? [] }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/reports GET]', error);
    return NextResponse.json({ error: 'Failed to load reports' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
