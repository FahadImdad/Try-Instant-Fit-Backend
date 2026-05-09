import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/reports/[id]
 *   Resolve a try-on report.
 *
 *   Body:
 *     { action: 'approve' | 'deny' | 'close',
 *       resolution_note?: string,
 *       resolved_by?:     string }
 *
 *   - 'approve' → calls the refund_credit_for_report() Postgres function,
 *     which atomically: locks the report, refunds 1 credit (decrements
 *     brand.tryon_credits_used), writes a credit_ledger row of kind=refund,
 *     and marks the report status='approved' with credit_refunded=TRUE.
 *     Only valid for type IN ('tryon_bad','image_bad') and status='pending'.
 *
 *   - 'deny'  → marks status='denied'. No credit refund.
 *   - 'close' → marks status='closed' (used for feedback / difficulty
 *     reports that don't need a yes/no decision).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const action          = body.action as string | undefined;
    const resolutionNote  = (body.resolution_note as string | undefined)?.trim() || null;
    const resolvedBy      = (body.resolved_by as string | undefined)?.trim() || 'admin';

    if (!action || !['approve', 'deny', 'close'].includes(action)) {
      return NextResponse.json(
        { error: "action must be 'approve', 'deny', or 'close'" },
        { status: 400, headers: ADMIN_CORS },
      );
    }

    // ── APPROVE: route through the atomic refund function ──
    if (action === 'approve') {
      const { data: refundData, error: refundError } = await supabase.rpc('refund_credit_for_report', {
        p_report_id:    id,
        p_resolved_by:  resolvedBy,
        p_resolution:   resolutionNote,
      });
      if (refundError) {
        // The function raises detailed exceptions for the common rejection
        // paths (already resolved, wrong type, etc). Surface them verbatim.
        return NextResponse.json(
          { error: refundError.message || 'Refund failed' },
          { status: 400, headers: ADMIN_CORS },
        );
      }

      // Read back the resolved report so the admin UI can update its row
      const { data: report, error: readErr } = await supabase
        .from('tryon_reports').select('*').eq('id', id).single();
      if (readErr) throw readErr;

      return NextResponse.json(
        { report, refund: refundData?.[0] ?? null },
        { status: 200, headers: ADMIN_CORS },
      );
    }

    // ── DENY / CLOSE: just status update ──
    const newStatus = action === 'deny' ? 'denied' : 'closed';
    const { data, error } = await supabase
      .from('tryon_reports')
      .update({
        status:          newStatus,
        resolved_by:     resolvedBy,
        resolved_at:     new Date().toISOString(),
        resolution_note: resolutionNote,
      })
      .eq('id', id)
      .eq('status', 'pending')   // never overwrite an already-resolved row
      .select('*')
      .single();
    if (error) {
      // .single() error fires if 0 rows matched (already resolved)
      return NextResponse.json(
        { error: 'Report not found or already resolved' },
        { status: 400, headers: ADMIN_CORS },
      );
    }

    return NextResponse.json({ report: data }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/reports PATCH]', error);
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
