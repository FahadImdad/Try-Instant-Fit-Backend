import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { QR_CORS } from '@/lib/qr';

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/qr-codes
 * List all QR codes for a brand (for dashboard).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const { data, error } = await supabase
      .from('qr_codes')
      .select('id, token, product_id, product_name, display_image_url, requires_passcode, total_limit, total_used, expires_at, active, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // For each QR, count passcodes for the dashboard summary
    const qrIds = (data ?? []).map(q => q.id);
    const passcodeCounts: Record<string, number> = {};
    if (qrIds.length > 0) {
      const { data: pcRows } = await supabase
        .from('qr_passcodes')
        .select('qr_id')
        .in('qr_id', qrIds)
        .eq('active', true);
      pcRows?.forEach(r => {
        passcodeCounts[r.qr_id] = (passcodeCounts[r.qr_id] || 0) + 1;
      });
    }

    const scanBase = process.env.PUBLIC_SCAN_BASE_URL || 'https://tryinstantfit.vercel.app';
    const qrs = (data ?? []).map(q => ({
      ...q,
      active_passcodes: passcodeCounts[q.id] || 0,
      scan_url: `${scanBase}/scan.html?token=${q.token}`,
    }));

    return NextResponse.json({ qr_codes: qrs }, { status: 200, headers: QR_CORS });
  } catch (error) {
    console.error('[brands/qr-codes] Error:', error);
    return NextResponse.json({ error: 'Failed to list QR codes' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
