import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/admin/brands/[brandId]
 *   Full brand detail incl. recent topups.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { brandId } = await params;

    const [{ data: brand, error: brandError }, { data: topups }] = await Promise.all([
      supabase.from('brands').select('*').eq('id', brandId).single(),
      supabase.from('brand_credit_topups').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }).limit(50),
    ]);

    if (brandError || !brand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: ADMIN_CORS });
    }

    return NextResponse.json({ brand, topups: topups ?? [] }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/brands/[brandId] GET]', error);
    return NextResponse.json({ error: 'Failed to load brand' }, { status: 500, headers: ADMIN_CORS });
  }
}

/**
 * PATCH /api/admin/brands/[brandId]
 *   Update brand fields: name, status, price_per_tryon_usd, unlimited, etc.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { brandId } = await params;
    const body = await request.json();
    const allowedFields = ['name', 'status', 'website_url', 'price_per_tryon_usd', 'unlimited'];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allowedFields) if (k in body) update[k] = body[k];

    const { data, error } = await supabase
      .from('brands')
      .update(update)
      .eq('id', brandId)
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ brand: data }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/brands/[brandId] PATCH]', error);
    return NextResponse.json({ error: 'Failed to update brand' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
