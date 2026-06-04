import { NextRequest, NextResponse } from 'next/server';
import { refreshFxRates } from '@/lib/fx';

// Daily refresh of cached FX rates. Protected by CRON_SECRET so only the
// scheduler (Vercel cron or an external scheduler hitting this URL) can run it.
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const updated = await refreshFxRates();
    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 502 for provider/parse issues, 500 for DB — caller logs are enough here.
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
