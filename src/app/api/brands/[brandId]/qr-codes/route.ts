import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireBrandAuth } from '@/lib/brand-auth';
import { QR_CORS } from '@/lib/qr';

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/qr-codes
 * List all QR codes for a brand (for dashboard).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const unauthorized = requireBrandAuth(request, brandId); if (unauthorized) return unauthorized;

    const { data, error } = await supabase
      .from('qr_codes')
      .select('id, token, product_id, product_uuid, product_name, display_image_url, requires_passcode, total_limit, total_used, free_used_count, expires_at, active, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const qrRows = data ?? [];
    const qrIds = qrRows.map(q => q.id);

    // Usage counts come from `tryons`, not `qr_scans`.
    //
    // A try-on row is written for every successful try-on and stamps
    // brand_passcode_id as it runs, so it is the authoritative record both of
    // what happened and of which try-ons used a passcode. A scan row is
    // written alongside, but a try-on can exist without a completed scan row —
    // counting scans under-reported the total, and the dashboard then derived
    // "free" by subtracting passcode from a different, larger total, which is
    // what inflated that figure on the product card.
    //
    // Taking all three from one table means total = free + passcode always
    // reconciles.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: tryonRows } = qrIds.length
      ? await supabase
          .from('tryons')
          .select('product_id, product_uuid, product_name, brand_passcode_id, created_at')
          .eq('brand_id', brandId)
      : { data: [] };

    // Keyed by both SKU and product uuid, mirroring how a QR resolves its
    // product below, so either linkage counts.
    const usageByProduct: Record<string, { today: number; free: number; passcode: number; total: number }> = {};
    const bump = (key: string | null, row: { brand_passcode_id: string | null; created_at: string }) => {
      if (!key) return;
      const stats = usageByProduct[key] ?? { today: 0, free: 0, passcode: 0, total: 0 };
      stats.total += 1;
      if (row.brand_passcode_id) stats.passcode += 1; else stats.free += 1;
      if (new Date(row.created_at) >= todayStart) stats.today += 1;
      usageByProduct[key] = stats;
    };

    for (const t of tryonRows ?? []) {
      // "[Setup] …" rows are the one-off garment isolation charged when a
      // product is added — not a customer try-on.
      if ((t.product_name ?? '').startsWith('[Setup]')) continue;
      bump(t.product_id, t);
      if (t.product_uuid && t.product_uuid !== t.product_id) bump(t.product_uuid, t);
    }

    // Fetch all the brand's products in one shot, key by id and sku
    const { data: productRows } = await supabase
      .from('products')
      .select('id, sku, name, price, currency, image_url, isolated_garment_url')
      .eq('brand_id', brandId);
    const productByUuid: Record<string, NonNullable<typeof productRows>[number]> = {};
    const productBySku: Record<string, NonNullable<typeof productRows>[number]> = {};
    productRows?.forEach(p => {
      productByUuid[p.id] = p;
      productBySku[p.sku] = p;
    });

    // Legacy isolated garments (for QRs created before products table)
    const skus = Array.from(new Set(qrRows.map(q => q.product_id).filter(Boolean)));
    const isolatedBySku: Record<string, string> = {};
    if (skus.length > 0) {
      const { data: garmentRows } = await supabase
        .from('product_garments')
        .select('product_id, isolated_garment_url')
        .eq('brand_id', brandId)
        .in('product_id', skus);
      garmentRows?.forEach(g => {
        if (g.isolated_garment_url) isolatedBySku[g.product_id] = g.isolated_garment_url;
      });
    }

    // Brand-wide active passcode count (one number for the whole brand, not per-QR)
    const { count: activePasscodes } = await supabase
      .from('brand_passcodes')
      .select('id', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .eq('active', true);

    const scanBase = process.env.PUBLIC_SCAN_BASE_URL || 'https://tryinstantfit.com';
    const qrs = qrRows.map(q => {
      const p = (q.product_uuid && productByUuid[q.product_uuid]) || productBySku[q.product_id];
      // Resolve usage the same way the product itself is resolved: by uuid
      // first, then SKU.
      const usage = (q.product_uuid && usageByProduct[q.product_uuid]) || usageByProduct[q.product_id];
      return {
        ...q,
        today_tryons: usage?.today ?? 0,
        free_tryons: usage?.free ?? 0,
        passcode_tryons: usage?.passcode ?? 0,
        // Authoritative total, so the card's three figures always reconcile.
        total_tryons: usage?.total ?? 0,
        product: p
          ? { id: p.id, sku: p.sku, name: p.name, price: p.price, currency: p.currency, image_url: p.image_url }
          : null,
        // Prefer products.image_url, then qr.display_image_url, then null
        display_image_url: p?.image_url || q.display_image_url || null,
        isolated_garment_url: p?.isolated_garment_url || isolatedBySku[q.product_id] || null,
        // Brand-wide passcode count (same number on every card)
        brand_active_passcodes: activePasscodes ?? 0,
        scan_url: `${scanBase}/scan/${q.token}`,
      };
    });

    return NextResponse.json({ qr_codes: qrs }, { status: 200, headers: QR_CORS });
  } catch (error) {
    console.error('[brands/qr-codes] Error:', error);
    return NextResponse.json({ error: 'Failed to list QR codes' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
