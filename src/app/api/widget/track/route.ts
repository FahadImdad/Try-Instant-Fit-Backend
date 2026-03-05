import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { brand_id, event_name, event_data, page_url, timestamp } = body;

    if (!brand_id || !event_name) {
      return NextResponse.json({ error: 'brand_id and event_name are required' }, { status: 400 });
    }

    // Fire-and-forget insert — analytics should never block the widget
    supabase
      .from('analytics_events')
      .insert({
        brand_id,
        event_name,
        event_data: event_data ?? {},
        page_url: page_url ?? null,
        product: 'ghost-layer',
        created_at: timestamp ?? new Date().toISOString(),
      })
      .then(({ error }) => {
        if (error) console.error('[track] Insert error:', error.message);
      });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[track] Error:', error);
    return NextResponse.json({ error: 'Failed to track event' }, { status: 500 });
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
