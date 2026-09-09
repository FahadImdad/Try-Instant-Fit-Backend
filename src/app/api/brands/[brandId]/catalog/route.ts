import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

/**
 * GET /api/brands/[brandId]/catalog
 *
 * PUBLIC, customer-facing. Powers the "More from {Brand}" browse grid on the
 * scan page so a shopper who scanned one product can see the brand's whole
 * range and try on any item the brand chose to show.
 *
 * Visibility rules — a product is returned ONLY when all three hold:
 *   1. brands.catalog_enabled = TRUE   (brand-level master switch)
 *   2. products.active        = TRUE   (not soft-deleted)
 *   3. products.show_in_catalog = TRUE (per-product opt-out)
 *
 * If the brand has catalog browsing disabled, we return an empty list with
 * catalog_enabled:false so the scan page can simply hide the section.
 *
 * Each item carries its product's own scan `token` (from its QR, if one
 * exists) so the scan page can hand off to the existing, proven QR-based
 * try-on flow without minting anything. Items also include product_uuid as a
 * fallback for the QR-less try-on path.
 *
 * Optional query params:
 *   ?exclude=<product_uuid>  — omit the product the shopper is already on.
 *   ?limit=<n>               — cap results (default 60, max 120).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ brandId: string }> },
) {
  try {
    const { brandId } = await params;
    const url = new URL(request.url);
    const exclude = url.searchParams.get('exclude');
    const limitParam = parseInt(url.searchParams.get('limit') || '60', 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 120) : 60;

    // Brand-level master switch. Also confirms the brand exists.
    const { data: brand } = await supabase
      .from('brands')
      .select('id, name, catalog_enabled, logo_url, primary_color, website_url')
      .eq('id', brandId)
      .maybeSingle();

    if (!brand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: QR_CORS });
    }
    if (brand.catalog_enabled === false) {
      return NextResponse.json(
        { catalog_enabled: false, products: [] },
        { status: 200, headers: QR_CORS },
      );
    }

    // Catalog-eligible products only. We need an isolated garment for try-on,
    // so rows without one are skipped client-side-safe (filtered below).
    let query = supabase
      .from('products')
      .select('id, sku, name, price, currency, description, category, category_group, audience, available_sizes, custom_size_available, custom_size_note, buy_url, image_url, isolated_garment_url')
      .eq('brand_id', brandId)
      .eq('active', true)
      .eq('show_in_catalog', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (exclude) query = query.neq('id', exclude);

    const { data: products, error } = await query;
    if (error) throw error;

    const rows = products ?? [];

    // Pull active QR tokens for these products in one query so each catalog
    // tile can deep-link straight into the existing /scan/:token try-on flow.
    const uuids = rows.map(p => p.id);
    const tokenByUuid = new Map<string, string>();
    if (uuids.length) {
      const { data: qrs } = await supabase
        .from('qr_codes')
        .select('product_uuid, token, created_at')
        .eq('brand_id', brandId)
        .eq('active', true)
        .in('product_uuid', uuids)
        .order('created_at', { ascending: false });
      // Newest active QR wins if a product somehow has more than one.
      for (const qr of qrs ?? []) {
        if (qr.product_uuid && !tokenByUuid.has(qr.product_uuid)) {
          tokenByUuid.set(qr.product_uuid, qr.token);
        }
      }
    }

    // A product is only try-on-able once its garment is isolated. Keep rows
    // that either have a cached garment OR a scan token (the token's QR
    // guarantees an isolated garment existed at creation time).
    const items = rows
      .filter(p => p.isolated_garment_url || tokenByUuid.has(p.id))
      .map(p => ({
        product_uuid: p.id,
        sku: p.sku,
        name: p.name,
        price: p.price ?? null,
        currency: p.currency || null,
        description: p.description || null,
        category: p.category || null,
        category_group: p.category_group || null,
        audience: p.audience || null,
        available_sizes: p.available_sizes ?? [],
        custom_size_available: p.custom_size_available === true,
        custom_size_note: p.custom_size_note || null,
        buy_url: p.buy_url || null,
        image_url: p.image_url || null,
        token: tokenByUuid.get(p.id) || null,
      }));

    return NextResponse.json(
      {
        catalog_enabled: true,
        brand: {
          id: brand.id,
          name: brand.name,
          logo_url: brand.logo_url ?? null,
          primary_color: brand.primary_color ?? null,
          website_url: brand.website_url ?? null,
        },
        count: items.length,
        products: items,
      },
      { status: 200, headers: QR_CORS },
    );
  } catch (error) {
    console.error('[brands/catalog GET]', error);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
