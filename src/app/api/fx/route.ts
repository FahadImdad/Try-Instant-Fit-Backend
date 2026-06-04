import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const FALLBACK_RATES: Record<string, number> = {
  PKR: 285,
};

const STALE_AFTER_HOURS = 48;

export async function GET(request: NextRequest) {
  const currency = (request.nextUrl.searchParams.get('to') ?? 'PKR').toUpperCase();

  const { data, error } = await supabase
    .from('fx_rates')
    .select('rate, fetched_at, source')
    .eq('currency', currency)
    .maybeSingle();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
  };

  if (error || !data) {
    const fallback = FALLBACK_RATES[currency];
    if (fallback === undefined) {
      return NextResponse.json(
        { error: `No rate available for ${currency}` },
        { status: 404, headers: cors },
      );
    }
    return NextResponse.json(
      { from: 'USD', to: currency, rate: fallback, stale: true, source: 'fallback' },
      { headers: cors },
    );
  }

  const ageMs = Date.now() - new Date(data.fetched_at).getTime();
  const stale = ageMs > STALE_AFTER_HOURS * 3600 * 1000;

  return NextResponse.json(
    {
      from:       'USD',
      to:         currency,
      rate:       Number(data.rate),
      fetched_at: data.fetched_at,
      source:     data.source,
      stale,
    },
    { headers: cors },
  );
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
