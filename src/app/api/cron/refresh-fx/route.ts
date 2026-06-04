import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const FX_SOURCE = 'https://open.er-api.com/v6/latest/USD';
const CURRENCIES = ['PKR'];

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const res = await fetch(FX_SOURCE, { cache: 'no-store' });
  if (!res.ok) {
    return NextResponse.json(
      { error: `FX provider returned ${res.status}` },
      { status: 502 },
    );
  }

  const data = await res.json();
  if (data?.result !== 'success' || !data?.rates) {
    return NextResponse.json({ error: 'Malformed FX response' }, { status: 502 });
  }

  const rows = CURRENCIES
    .filter((c) => typeof data.rates[c] === 'number')
    .map((c) => ({
      currency:   c,
      rate:       data.rates[c],
      source:     'open.er-api.com',
      fetched_at: new Date().toISOString(),
    }));

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No target currencies in response' }, { status: 502 });
  }

  const { error } = await supabase.from('fx_rates').upsert(rows, { onConflict: 'currency' });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updated: rows });
}
