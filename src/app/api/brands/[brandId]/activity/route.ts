import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireBrandAuth, BRAND_CORS } from '@/lib/brand-auth';

/**
 * GET /api/brands/[brandId]/activity
 *
 * The account's activity feed, newest first.
 *
 * Two sources are merged:
 *
 *  1. activity_log — changes that leave no trace in the domain tables, such as
 *     a QR switching between free and passcode access. These only exist from
 *     the day logging was added.
 *  2. The domain tables themselves — a product row is proof the product was
 *     added, a topup row proof credits arrived. Deriving these means the feed
 *     carries the account's whole history rather than starting empty, and
 *     avoids double-writing facts the database already holds.
 *
 * Try-ons are grouped per day. There are hundreds of them and listing each one
 * would bury everything else.
 */

interface Item {
  id: string;
  at: string;
  icon: string;
  title: string;
  detail?: string;
  entity: string;
  actor: string;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const unauthorized = requireBrandAuth(request, brandId); if (unauthorized) return unauthorized;

  try {
    const [logged, products, qrs, passcodes, topups, requests, tryons] = await Promise.all([
      supabase.from('activity_log')
        .select('id, action, entity, entity_id, summary, detail, actor, created_at')
        .eq('brand_id', brandId).order('created_at', { ascending: false }).limit(500),
      supabase.from('products').select('id, name, sku, created_at').eq('brand_id', brandId),
      supabase.from('qr_codes').select('id, product_name, product_id, created_at').eq('brand_id', brandId),
      supabase.from('brand_passcodes').select('id, code, customer_label, use_limit, created_at').eq('brand_id', brandId),
      supabase.from('brand_credit_topups').select('id, credits_added, amount_usd, created_at').eq('brand_id', brandId),
      supabase.from('credit_topup_requests')
        .select('id, credits_requested, amount_usd, status, created_at, reviewed_at, rejection_reason').eq('brand_id', brandId),
      supabase.from('tryons').select('id, product_name, product_id, brand_passcode_id, created_at').eq('brand_id', brandId),
    ]);

    const items: Item[] = [];

    for (const r of logged.data ?? []) {
      items.push({
        id: `log-${r.id}`, at: r.created_at, entity: r.entity, actor: r.actor,
        icon: r.entity === 'qr' ? '🔑' : r.entity === 'product' ? '👕' : r.entity === 'credits' ? '💳' : '•',
        title: r.summary,
        detail: (r.detail as { note?: string })?.note,
      });
    }

    for (const p of products.data ?? []) {
      items.push({
        id: `prod-${p.id}`, at: p.created_at, entity: 'product', actor: 'brand',
        icon: '👕', title: `Added product "${p.name || p.sku}"`,
        detail: p.sku ? `SKU ${p.sku}` : undefined,
      });
    }

    for (const q of qrs.data ?? []) {
      items.push({
        id: `qr-${q.id}`, at: q.created_at, entity: 'qr', actor: 'system',
        icon: '🔗', title: `QR code generated for "${q.product_name || q.product_id}"`,
      });
    }

    for (const p of passcodes.data ?? []) {
      items.push({
        id: `pass-${p.id}`, at: p.created_at, entity: 'passcode', actor: 'brand',
        icon: '🔑', title: `Created passcode ${p.code}`,
        detail: [p.customer_label, p.use_limit ? `${p.use_limit} try-ons` : null].filter(Boolean).join(' · ') || undefined,
      });
    }

    for (const t of topups.data ?? []) {
      items.push({
        id: `top-${t.id}`, at: t.created_at, entity: 'credits', actor: 'admin',
        icon: '💳', title: `${t.credits_added} credits added`,
        detail: t.amount_usd ? `$${Number(t.amount_usd).toFixed(2)}` : undefined,
      });
    }

    for (const r of requests.data ?? []) {
      items.push({
        id: `req-${r.id}`, at: r.created_at, entity: 'credits', actor: 'brand',
        icon: '🧾', title: `Requested ${r.credits_requested} credits`,
        detail: r.amount_usd ? `$${Number(r.amount_usd).toFixed(2)}` : undefined,
      });
      // The review is a second, later event — record it at its own time.
      if (r.reviewed_at && r.status !== 'pending') {
        items.push({
          id: `req-rev-${r.id}`, at: r.reviewed_at, entity: 'credits', actor: 'admin',
          icon: r.status === 'approved' ? '✅' : '⛔',
          title: `Top-up request ${r.status}`,
          detail: r.rejection_reason || undefined,
        });
      }
    }

    // Try-ons, grouped by calendar day. Setup rows are the one-off garment
    // isolation charged at upload, not customer try-ons.
    const byDay = new Map<string, { free: number; passcode: number; products: Set<string> }>();
    for (const t of tryons.data ?? []) {
      if ((t.product_name ?? '').startsWith('[Setup]') || (t.product_name ?? '').startsWith('[Reprocess]')) continue;
      const day = String(t.created_at).slice(0, 10);
      const g = byDay.get(day) ?? { free: 0, passcode: 0, products: new Set<string>() };
      if (t.brand_passcode_id) g.passcode += 1; else g.free += 1;
      if (t.product_name) g.products.add(t.product_name);
      byDay.set(day, g);
    }
    for (const [day, g] of byDay) {
      const total = g.free + g.passcode;
      const parts = [];
      if (g.free) parts.push(`${g.free} free`);
      if (g.passcode) parts.push(`${g.passcode} passcode`);
      const names = [...g.products];
      items.push({
        id: `try-${day}`,
        // End of that day, so the group sorts above the individual events that
        // happened earlier the same day.
        at: `${day}T23:59:59.000Z`,
        entity: 'tryon', actor: 'customer', icon: '✨',
        title: `${total} try-on${total === 1 ? '' : 's'}`,
        detail: [parts.join(' · '), names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '') : null]
          .filter(Boolean).join(' — '),
      });
    }

    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return NextResponse.json({ activity: items.slice(0, 400) }, { headers: BRAND_CORS });
  } catch (e) {
    console.error('[brands/activity GET]', e);
    return NextResponse.json({ error: 'Could not load your activity.' }, { status: 500, headers: BRAND_CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: BRAND_CORS });
}
