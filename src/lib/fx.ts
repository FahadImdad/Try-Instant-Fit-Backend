import { supabase } from '@/lib/supabase';

// USD-based FX. One free provider, no API key. We cache rates in the fx_rates
// table and refresh them daily (via cron) or inline (self-heal in /api/fx when
// the cached rate is older than the self-heal threshold).

const FX_SOURCE = 'https://open.er-api.com/v6/latest/USD';
export const FX_PROVIDER = 'open.er-api.com';

// Currencies we track and expose (USD is the base, always 1).
export const FX_CURRENCIES = ['PKR'] as const;

export interface FxRow {
  currency: string;
  rate: number;
  source: string;
  fetched_at: string;
}

/**
 * Fetch live USD-based rates for FX_CURRENCIES and upsert them into fx_rates.
 * Returns the rows written. Throws on provider / DB failure so callers can
 * decide whether to fall back to the cached value.
 */
export async function refreshFxRates(): Promise<FxRow[]> {
  const res = await fetch(FX_SOURCE, { cache: 'no-store' });
  if (!res.ok) throw new Error(`FX provider returned ${res.status}`);

  const data = await res.json();
  if (data?.result !== 'success' || !data?.rates) {
    throw new Error('Malformed FX response');
  }

  const rows: FxRow[] = FX_CURRENCIES
    .filter((c) => typeof data.rates[c] === 'number')
    .map((c) => ({
      currency:   c,
      rate:       data.rates[c],
      source:     FX_PROVIDER,
      fetched_at: new Date().toISOString(),
    }));

  if (rows.length === 0) throw new Error('No target currencies in response');

  const { error } = await supabase.from('fx_rates').upsert(rows, { onConflict: 'currency' });
  if (error) throw new Error(error.message);

  return rows;
}
