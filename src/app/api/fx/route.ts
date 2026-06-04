import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { refreshFxRates } from '@/lib/fx';

const FALLBACK_RATES: Record<string, number> = {
  PKR: 285,
};

// A rate is flagged "stale" in the payload after this age...
const STALE_AFTER_HOURS = 48;
// ...but we proactively self-heal (refresh inline) once it crosses this
// younger threshold, so the site effectively never serves a >24h rate even
// if the daily scheduler misses a run. The inline refresh is best-effort:
// if the provider is down we still serve the cached value.
const SELF_HEAL_AFTER_HOURS = 24;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
};

async function readRow(currency: string) {
  const { data } = await supabase
    .from('fx_rates')
    .select('rate, fetched_at, source')
    .eq('currency', currency)
    .maybeSingle();
  return data;
}

export async function GET(request: NextRequest) {
  const currency = (request.nextUrl.searchParams.get('to') ?? 'PKR').toUpperCase();

  let data = await readRow(currency);

  // Self-heal: if there's no cached row, or it's older than the self-heal
  // threshold, try to refresh inline. Best-effort — never let a provider
  // outage turn into an error response; fall back to whatever we already have.
  const ageMs = data ? Date.now() - new Date(data.fetched_at).getTime() : Infinity;
  if (ageMs > SELF_HEAL_AFTER_HOURS * 3600 * 1000) {
    try {
      await refreshFxRates();
      data = await readRow(currency);
    } catch (err) {
      console.warn('[fx] inline self-heal failed, serving cached/fallback:', err instanceof Error ? err.message : err);
    }
  }

  if (!data) {
    const fallback = FALLBACK_RATES[currency];
    if (fallback === undefined) {
      return NextResponse.json(
        { error: `No rate available for ${currency}` },
        { status: 404, headers: CORS },
      );
    }
    return NextResponse.json(
      { from: 'USD', to: currency, rate: fallback, stale: true, source: 'fallback' },
      { headers: CORS },
    );
  }

  const stale = (Date.now() - new Date(data.fetched_at).getTime()) > STALE_AFTER_HOURS * 3600 * 1000;

  return NextResponse.json(
    {
      from:       'USD',
      to:         currency,
      rate:       Number(data.rate),
      fetched_at: data.fetched_at,
      source:     data.source,
      stale,
    },
    { headers: CORS },
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
