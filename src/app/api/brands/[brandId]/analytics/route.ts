import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ brandId: string }> }
) {
  const { brandId } = await params;

  try {
    // Brand info
    const { data: brand } = await supabase
      .from('brands')
      .select('id, name, email, website_url, status, created_at')
      .eq('id', brandId)
      .single();

    if (!brand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
    }

    // Total try-ons
    const { count: total } = await supabase
      .from('tryons')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId);

    // Today's try-ons
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: today } = await supabase
      .from('tryons')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .gte('created_at', todayStart.toISOString());

    // This week
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const { count: this_week } = await supabase
      .from('tryons')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .gte('created_at', weekStart.toISOString());

    // This month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { count: this_month } = await supabase
      .from('tryons')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .gte('created_at', monthStart.toISOString());

    // Button clicks (widget_opened events)
    const { count: button_clicks } = await supabase
      .from('analytics_events')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .eq('event_name', 'tryon_opened');

    // Avg processing time
    const { data: timings } = await supabase
      .from('tryons')
      .select('processing_time_ms')
      .eq('brand_id', brandId)
      .not('processing_time_ms', 'is', null);

    const avg_processing_ms =
      timings?.length
        ? Math.round(timings.reduce((s, r) => s + (r.processing_time_ms ?? 0), 0) / timings.length)
        : null;

    // Recent try-ons
    const { data: recent } = await supabase
      .from('tryons')
      .select('id, product_id, product_name, result_image_url, processing_time_ms, created_at, ai_model')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false })
      .limit(50);

    // Cached isolated garments per product
    const { data: garments } = await supabase
      .from('product_garments')
      .select('product_id, isolated_garment_url, mime_type, created_at')
      .eq('brand_id', brandId);

    // Build per-product breakdown
    const productMap = new Map<string, {
      product_id: string;
      product_name: string;
      tryon_count: number;
      isolated_garment_url: string | null;
      recent_tryons: { id: string; result_image_url: string | null; created_at: string }[];
    }>();

    for (const r of (recent ?? [])) {
      const pid = r.product_id ?? 'unknown';
      if (!productMap.has(pid)) {
        productMap.set(pid, {
          product_id:            pid,
          product_name:          r.product_name ?? pid,
          tryon_count:           0,
          isolated_garment_url:  null,
          recent_tryons:         [],
        });
      }
      const p = productMap.get(pid)!;
      p.tryon_count++;
      if (p.recent_tryons.length < 12) {
        p.recent_tryons.push({ id: r.id, result_image_url: r.result_image_url, created_at: r.created_at });
      }
    }

    // Attach isolated garment URLs
    for (const g of (garments ?? [])) {
      if (productMap.has(g.product_id)) {
        productMap.get(g.product_id)!.isolated_garment_url = g.isolated_garment_url;
      }
    }

    const products = Array.from(productMap.values())
      .sort((a, b) => b.tryon_count - a.tryon_count);

    return NextResponse.json({
      brand,
      stats: {
        total_tryons: total ?? 0,
        today: today ?? 0,
        this_week: this_week ?? 0,
        this_month: this_month ?? 0,
        avg_processing_ms,
        button_clicks: button_clicks ?? 0,
      },
      recent: (recent ?? []).slice(0, 20),
      products,
    });
  } catch (error) {
    console.error('[analytics] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
