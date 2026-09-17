import { supabase } from '@/lib/supabase';

/**
 * Record an account activity.
 *
 * Deliberately fire-and-forget: an audit entry must never be the reason a
 * product upload or a try-on fails. Failures are logged server-side and
 * swallowed.
 *
 * Only record what cannot be reconstructed later. A product row already proves
 * the product was added, and the vendor view derives that entry from the table
 * itself; what it cannot derive is a change over time, such as a QR switching
 * between free and passcode access.
 */
export async function logActivity(entry: {
  brandId: string;
  action: string;
  entity: 'product' | 'qr' | 'passcode' | 'credits' | 'tryon' | 'report' | 'brand';
  entityId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  actor?: 'brand' | 'admin' | 'customer' | 'system';
}): Promise<void> {
  try {
    const { error } = await supabase.from('activity_log').insert({
      brand_id:  entry.brandId,
      action:    entry.action,
      entity:    entry.entity,
      entity_id: entry.entityId ?? null,
      summary:   entry.summary,
      detail:    entry.detail ?? {},
      actor:     entry.actor ?? 'brand',
    });
    if (error) console.error('[activity] insert failed:', error.message);
  } catch (e) {
    console.error('[activity] insert threw:', e);
  }
}
