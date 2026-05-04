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

/**
 * DELETE /api/admin/brands/[brandId]
 *   Permanently delete a brand and its dependent rows (try-ons,
 *   passcodes, products, QR codes, topup requests, audit logs).
 *   Irreversible. Used when admin wants to remove a test/wrong account.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { brandId } = await params;

    // Verify brand exists first so we return a clean 404
    const { data: existing, error: fetchError } = await supabase
      .from('brands')
      .select('id, name')
      .eq('id', brandId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: ADMIN_CORS });
    }

    // Best-effort dependent cleanup. We delete child rows before the
    // brand row so foreign-key constraints don't block the final delete.
    // Each table is wrapped in its own try/catch — if a table doesn't
    // exist (older deployments), we still proceed.
    const dependentTables = [
      'tryons',
      'qr_scans',
      'qr_codes',
      'brand_passcodes',
      'product_garments',
      'products',
      'credit_topup_requests',
      'brand_credit_topups',
    ];
    for (const t of dependentTables) {
      try {
        await supabase.from(t).delete().eq('brand_id', brandId);
      } catch (e) {
        console.warn(`[admin/brands DELETE] non-fatal: failed to clean ${t}:`, e);
      }
    }

    const { error: deleteError } = await supabase.from('brands').delete().eq('id', brandId);
    if (deleteError) throw deleteError;

    return NextResponse.json(
      { ok: true, deleted: { id: brandId, name: existing.name } },
      { status: 200, headers: ADMIN_CORS }
    );
  } catch (error) {
    console.error('[admin/brands/[brandId] DELETE]', error);
    return NextResponse.json({ error: 'Failed to delete brand' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
