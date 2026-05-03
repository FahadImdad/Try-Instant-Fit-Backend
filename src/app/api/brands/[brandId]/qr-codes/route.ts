import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/qr-codes
 * List all QR codes for a brand (for dashboard).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const { data, error } = await supabase
      .from('qr_codes')
      .select('id, token, product_id, product_uuid, product_name, display_image_url, requires_passcode, total_limit, total_used, expires_at, active, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const qrRows = data ?? [];

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
        product: p
          ? { id: p.id, sku: p.sku, name: p.name, price: p.price, currency: p.currency, image_url: p.image_url }
          : null,
        // Prefer products.image_url, then qr.display_image_url, then null
        display_image_url: p?.image_url || q.display_image_url || null,
        isolated_garment_url: p?.isolated_garment_url || isolatedBySku[q.product_id] || null,
        // Brand-wide passcode count (same number on every card)
        brand_active_passcodes: activePasscodes ?? 0,
        scan_url: `${scanBase}/scan.html?token=${q.token}`,
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
