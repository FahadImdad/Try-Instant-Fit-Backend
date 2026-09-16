import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

/**
 * GET /api/brands/[brandId]/announcements
 *
 * Vendor-facing. Returns the announcements this brand should see on its
 * dashboard.
 *
 * An announcement is returned when all of these hold:
 *   1. active = TRUE
 *   2. starts_at is NULL or already passed
 *   3. ends_at   is NULL or not yet passed   (expiry)
 *   4. audience = 'all', OR this brand is listed in announcement_brands
 *
 * Expiry and targeting are enforced here rather than in the browser, so an
 * expired or untargeted announcement can never be revealed by a stale client.
 *
 * Dismissed announcements are still returned, flagged `dismissed: true`: the
 * banner hides them, but the bell keeps them so a vendor can find a notice
 * again after crossing it off.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;

  const nowIso = new Date().toISOString();

  const { data: rows, error } = await supabase
    .from('announcements')
    .select('id, title, body, level, audience, starts_at, ends_at, created_at, announcement_brands(brand_id)')
    .eq('active', true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[announcements] Failed to load:', error.message);
    return NextResponse.json({ announcements: [] }, { headers: QR_CORS });
  }

  const targeted = (rows ?? []).filter(
    (a) => a.audience === 'all' ||
      (a.announcement_brands ?? []).some((link: { brand_id: string }) => link.brand_id === brandId),
  );

  if (!targeted.length) return NextResponse.json({ announcements: [] }, { headers: QR_CORS });

  const { data: dismissals } = await supabase
    .from('announcement_dismissals')
    .select('announcement_id')
    .eq('brand_id', brandId)
    .in('announcement_id', targeted.map((a) => a.id));

  const dismissed = new Set((dismissals ?? []).map((d) => d.announcement_id));

  return NextResponse.json({
    announcements: targeted.map((a) => ({
      id:         a.id,
      title:      a.title,
      body:       a.body,
      level:      a.level,
      created_at: a.created_at,
      ends_at:    a.ends_at,
      dismissed:  dismissed.has(a.id),
    })),
  }, { headers: QR_CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: QR_CORS });
}
