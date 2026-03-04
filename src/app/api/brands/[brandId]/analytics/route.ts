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
      .select('id, product_name, result_image_url, processing_time_ms, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false })
      .limit(20);

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
      recent: recent ?? [],
    });
  } catch (error) {
    console.error('[analytics] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
