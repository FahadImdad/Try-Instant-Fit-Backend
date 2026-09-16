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
    const { data: scanRows } = qrIds.length
      ? await supabase
          .from('qr_scans')
          .select('qr_id, brand_passcode_id, completed_at, status')
          .in('qr_id', qrIds)
          .eq('status', 'completed')
      : { data: [] };
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const scanStats: Record<string, { today: number; free: number; passcode: number }> = {};
    for (const scan of scanRows ?? []) {
      const stats = scanStats[scan.qr_id] ?? { today: 0, free: 0, passcode: 0 };
      const completedAt = scan.completed_at;
      if (completedAt && new Date(completedAt) >= todayStart) stats.today += 1;
      if (scan.brand_passcode_id) stats.passcode += 1;
      else stats.free += 1;
      scanStats[scan.qr_id] = stats;
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
      return {
        ...q,
        today_tryons: scanStats[q.id]?.today ?? 0,
        free_tryons: scanStats[q.id]?.free ?? q.free_used_count ?? 0,
        passcode_tryons: scanStats[q.id]?.passcode ?? Math.max(0, (q.total_used ?? 0) - (q.free_used_count ?? 0)),
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
