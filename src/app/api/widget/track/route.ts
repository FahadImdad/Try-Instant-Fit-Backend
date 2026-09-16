import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { brand_id, event_name, event_data, page_url, timestamp } = body;

    if (!brand_id || !event_name) {
      return NextResponse.json({ error: 'brand_id and event_name are required' }, { status: 400 });
    }

    // Await persistence so serverless runtimes cannot terminate before the
    // analytics event reaches Supabase. Client calls remain non-blocking.
    const { error: insertError } = await supabase
      .from('analytics_events')
      .insert({
        brand_id,
        event_name,
        event_data: event_data ?? {},
        page_url: page_url ?? null,
        product: event_data?.source ?? 'ghost-layer',
        created_at: timestamp ?? new Date().toISOString(),
      });

    if (insertError) {
      console.error('[track] Insert error:', insertError.message);
      return NextResponse.json({ error: 'Failed to track event' }, { status: 500 });
    }

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
