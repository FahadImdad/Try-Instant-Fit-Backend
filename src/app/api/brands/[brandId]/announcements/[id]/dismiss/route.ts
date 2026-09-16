import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

/**
 * POST /api/brands/[brandId]/announcements/[id]/dismiss
 *
 * Vendor-facing. Records that this brand crossed the announcement off its
 * dashboard banner. The announcement is still returned by the list endpoint
 * with dismissed:true so it stays available in the bell history.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ brandId: string; id: string }> }) {
  const { brandId, id } = await params;

  // Only dismissable if the announcement actually exists — avoids writing rows
  // for ids that were never real.
  const { data: exists } = await supabase
    .from('announcements')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (!exists) {
    return NextResponse.json({ error: 'That announcement is no longer available.' }, { status: 404, headers: QR_CORS });
  }

  // Dismissing twice is not an error — the row is the desired end state.
  const { error } = await supabase
    .from('announcement_dismissals')
    .upsert({ announcement_id: id, brand_id: brandId }, { onConflict: 'announcement_id,brand_id' });

  if (error) {
    console.error('[announcements] Failed to dismiss:', error.message);
    return NextResponse.json({ error: 'Could not dismiss that notice. Please try again.' }, { status: 500, headers: QR_CORS });
  }

  return NextResponse.json({ ok: true }, { headers: QR_CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: QR_CORS });
}
