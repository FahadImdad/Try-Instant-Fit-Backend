import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/reports
 *   List reports for a single brand. Used by the dashboard to show
 *   the brand the status of customer-submitted reports about their
 *   QRs (pending → approved+credit_refunded → done, or denied).
 *
 *   Optional ?status=pending|approved|denied|closed
 *   Optional ?limit=50 (default 50, max 200)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    if (!brandId) {
      return NextResponse.json({ error: 'brandId required' }, { status: 400, headers: CORS });
    }

    const url    = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

    let q = supabase
      .from('tryon_reports')
      .select(`
        id, type, rating, reason, message, screenshot_url, result_url, source,
        status, resolved_at, resolution_note,
        credit_refunded, refund_at,
        product_id, qr_id, tryon_id, created_at
      `)
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    // Surface a quick summary so the dashboard can show a count badge
    const counts = (data ?? []).reduce((acc: Record<string, number>, r: { status: string }) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json(
      { reports: data ?? [], counts },
      { status: 200, headers: CORS },
    );
  } catch (error) {
    console.error('[brands/reports GET]', error);
    return NextResponse.json({ error: 'Failed to load reports' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
