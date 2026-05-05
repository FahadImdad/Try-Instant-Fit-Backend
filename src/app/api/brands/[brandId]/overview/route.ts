import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

type Source = 'ghost-layer' | 'scan-wear' | 'digital-mirror';
const SOURCES: Source[] = ['ghost-layer', 'scan-wear', 'digital-mirror'];

interface SourceStats {
  total: number;
  today: number;
  this_week: number;
  this_month: number;
  avg_processing_ms: number | null;
  cost_usd_total: number;
}

interface ProductBreakdown {
  product_id: string;
  product_name: string;
  source: Source;
  tryon_count: number;
  isolated_garment_url: string | null;
  recent_tryons: { id: string; result_image_url: string | null; created_at: string }[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ brandId: string }> }
) {
  const { brandId } = await params;

  try {
    // Brand info (incl. credit balance + profile fields the dashboard's
    // Edit Profile modal needs to pre-fill on open).
    const { data: brand } = await supabase
      .from('brands')
      .select('id, name, email, website_url, logo_url, primary_color, contact_name, contact_position, contact_phone, country, status, tryon_credits, tryon_credits_used, price_per_tryon_usd, unlimited, created_at')
      .eq('id', brandId)
      .single();

    if (!brand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS_HEADERS });
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    // ── Pull all try-ons for the brand (one query) and aggregate in code ─────
    // We pull only the columns we need and accept that heavy brands may have many rows
    // — at typical volumes (<50k/year) this is fine. Tightens N queries → 1.
    const { data: allTryons } = await supabase
      .from('tryons')
      .select('id, product_id, product_name, source, result_image_url, processing_time_ms, cost_usd, created_at, ai_model')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });

    // Drop internal "[Setup] ..." rows that get logged when a product is added
    // (they're audit entries for the AI isolation cost, not real customer
    // try-ons — the dashboard's TOTAL TRY-ONS / TODAY counters should reflect
    // customer activity, not setup work).
    const tryons = (allTryons ?? []).filter(r => !(r.product_name ?? '').startsWith('[Setup]'));

    // ── Compute overall + per-source stats from in-memory rows ───────────────
    function emptyStats(): SourceStats {
      return {
        total: 0,
        today: 0,
        this_week: 0,
        this_month: 0,
        avg_processing_ms: null,
        cost_usd_total: 0,
      };
    }

    const overall = emptyStats();
    const bySource: Record<Source, SourceStats> = {
      'ghost-layer': emptyStats(),
      'scan-wear': emptyStats(),
      'digital-mirror': emptyStats(),
    };

    const procSamples: { all: number[]; bySource: Record<Source, number[]> } = {
      all: [],
      bySource: { 'ghost-layer': [], 'scan-wear': [], 'digital-mirror': [] },
    };

    for (const r of tryons) {
      const src = (SOURCES.includes(r.source as Source) ? r.source : 'ghost-layer') as Source;
      const ts = new Date(r.created_at);
      const cost = Number(r.cost_usd ?? 0);

      overall.total++;
      bySource[src].total++;
      if (ts >= todayStart) { overall.today++; bySource[src].today++; }
      if (ts >= weekStart)  { overall.this_week++; bySource[src].this_week++; }
      if (ts >= monthStart) { overall.this_month++; bySource[src].this_month++; }

      overall.cost_usd_total += cost;
      bySource[src].cost_usd_total += cost;

      if (typeof r.processing_time_ms === 'number') {
        procSamples.all.push(r.processing_time_ms);
        procSamples.bySource[src].push(r.processing_time_ms);
      }
    }

    function avg(arr: number[]) {
      return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    }
    overall.avg_processing_ms = avg(procSamples.all);
    for (const s of SOURCES) bySource[s].avg_processing_ms = avg(procSamples.bySource[s]);

    // Round costs to 4 decimals
    overall.cost_usd_total = Math.round(overall.cost_usd_total * 10000) / 10000;
    for (const s of SOURCES) bySource[s].cost_usd_total = Math.round(bySource[s].cost_usd_total * 10000) / 10000;

    // ── Button clicks (Ghost Layer widget specific) ──────────────────────────
    const { count: buttonClicks } = await supabase
      .from('analytics_events')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .eq('event_name', 'tryon_opened');

    // ── Cached garments ──────────────────────────────────────────────────────
    const { data: garments } = await supabase
      .from('product_garments')
      .select('product_id, isolated_garment_url, mime_type, created_at')
      .eq('brand_id', brandId);

    const garmentByProductId: Record<string, string | null> = {};
    for (const g of (garments ?? [])) garmentByProductId[g.product_id] = g.isolated_garment_url ?? null;

    // ── Per-product breakdowns, grouped by source ────────────────────────────
    const productMap = new Map<string, ProductBreakdown>();
    for (const r of tryons) {
      const pid = r.product_id ?? 'unknown';
      const src = (SOURCES.includes(r.source as Source) ? r.source : 'ghost-layer') as Source;
      const key = `${src}:${pid}`;
      if (!productMap.has(key)) {
        productMap.set(key, {
          product_id: pid,
          product_name: r.product_name ?? pid,
          source: src,
          tryon_count: 0,
          isolated_garment_url: garmentByProductId[pid] ?? null,
          recent_tryons: [],
        });
      }
      const p = productMap.get(key)!;
      p.tryon_count++;
      if (p.recent_tryons.length < 12) {
        p.recent_tryons.push({ id: r.id, result_image_url: r.result_image_url, created_at: r.created_at });
      }
    }
    const allProducts = Array.from(productMap.values()).sort((a, b) => b.tryon_count - a.tryon_count);

    // ── Scan & Wear specific (QRs + brand-wide passcodes + scan events) ─────
    // Passcodes were migrated from per-QR (qr_passcodes) → brand-wide
    // (brand_passcodes); the dashboard's "Passcodes" count was reading from
    // the empty legacy table and always showing 0.
    const qrIdsResult = await supabase.from('qr_codes').select('id').eq('brand_id', brandId);
    const qrIds = qrIdsResult.data?.map(q => q.id) ?? [];
    const qrIdsForIn = qrIds.length ? qrIds : ['00000000-0000-0000-0000-000000000000'];
    const [{ count: qrTotal }, { count: qrActive }, { count: passcodeTotal }, { count: scansTotal }] = await Promise.all([
      supabase.from('qr_codes').select('*', { count: 'exact', head: true }).eq('brand_id', brandId),
      supabase.from('qr_codes').select('*', { count: 'exact', head: true }).eq('brand_id', brandId).eq('active', true),
      supabase.from('brand_passcodes').select('id', { count: 'exact', head: true }).eq('brand_id', brandId).eq('active', true),
      supabase.from('qr_scans').select('id', { count: 'exact', head: true }).in('qr_id', qrIdsForIn),
    ]);

    const recent = tryons.slice(0, 20).map(r => ({
      id: r.id,
      product_id: r.product_id,
      product_name: r.product_name,
      result_image_url: r.result_image_url,
      processing_time_ms: r.processing_time_ms,
      cost_usd: r.cost_usd,
      source: r.source,
      created_at: r.created_at,
      ai_model: r.ai_model,
    }));

    return NextResponse.json({
      brand,
      stats: {
        total_tryons: overall.total,
        today: overall.today,
        this_week: overall.this_week,
        this_month: overall.this_month,
        avg_processing_ms: overall.avg_processing_ms,
        button_clicks: buttonClicks ?? 0,
        cost_usd_total: overall.cost_usd_total,
      },
      by_source: {
        'ghost-layer': {
          ...bySource['ghost-layer'],
          button_clicks: buttonClicks ?? 0,
          conversion_rate: buttonClicks ? Math.round((bySource['ghost-layer'].total / buttonClicks) * 1000) / 10 : null,
          recent: recent.filter(r => r.source === 'ghost-layer').slice(0, 20),
          products: allProducts.filter(p => p.source === 'ghost-layer'),
        },
        'scan-wear': {
          ...bySource['scan-wear'],
          recent: recent.filter(r => r.source === 'scan-wear').slice(0, 20),
          products: allProducts.filter(p => p.source === 'scan-wear'),
          qr_count: qrTotal ?? 0,
          qr_active: qrActive ?? 0,
          passcode_count: passcodeTotal ?? 0,
          scans_total: scansTotal ?? 0,
        },
        'digital-mirror': {
          ...bySource['digital-mirror'],
          available: false, // not deployed for this brand
          recent: recent.filter(r => r.source === 'digital-mirror').slice(0, 20),
          products: allProducts.filter(p => p.source === 'digital-mirror'),
        },
      },
      // Legacy fields (existing dashboard still reads these)
      recent,
      products: allProducts.map(p => ({
        product_id: p.product_id,
        product_name: p.product_name,
        tryon_count: p.tryon_count,
        isolated_garment_url: p.isolated_garment_url,
        recent_tryons: p.recent_tryons,
      })),
    }, { headers: CORS_HEADERS });
  } catch (error) {
    console.error('[analytics] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500, headers: CORS_HEADERS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
