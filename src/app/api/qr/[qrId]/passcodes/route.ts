import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generatePasscode, QR_CORS } from '@/lib/qr';

interface RouteParams {
  params: Promise<{ qrId: string }>;
}

/**
 * GET /api/qr/[qrId]/passcodes
 * List all passcodes for a QR code (brand-side, for dashboard).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { qrId } = await params;

    const { data, error } = await supabase
      .from('qr_passcodes')
      .select('id, code, customer_label, use_limit, used_count, expires_at, active, created_at')
      .eq('qr_id', qrId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ passcodes: data ?? [] }, { status: 200, headers: QR_CORS });
  } catch (error) {
    console.error('[qr/passcodes GET] Error:', error);
    return NextResponse.json({ error: 'Failed to list passcodes' }, { status: 500, headers: QR_CORS });
  }
}

/**
 * POST /api/qr/[qrId]/passcodes
 * Create one or more passcodes for a QR.
 *
 * Body — single:
 *   { code?: string, customer_label?: string, use_limit: number, expires_at?: ISO }
 *   (if code omitted, one is auto-generated)
 *
 * Body — bulk:
 *   { count: number, use_limit: number, customer_label_prefix?: string, expires_at?: ISO }
 *   (generates `count` random codes, all with the same use_limit)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { qrId } = await params;
    const body = await request.json();

    // Verify QR exists
    const { data: qr } = await supabase.from('qr_codes').select('id').eq('id', qrId).maybeSingle();
    if (!qr) {
      return NextResponse.json({ error: 'QR not found' }, { status: 404, headers: QR_CORS });
    }

    // Bulk generation path
    if (typeof body.count === 'number') {
      const { count, use_limit, customer_label_prefix, expires_at } = body;

      if (count < 1 || count > 1000) {
        return NextResponse.json({ error: 'count must be between 1 and 1000' }, { status: 400, headers: QR_CORS });
      }
      if (typeof use_limit !== 'number' || use_limit < 1) {
        return NextResponse.json({ error: 'use_limit must be a positive number' }, { status: 400, headers: QR_CORS });
      }

      const rows = Array.from({ length: count }, (_, i) => ({
        qr_id: qrId,
        code: generatePasscode(),
        customer_label: customer_label_prefix ? `${customer_label_prefix} ${i + 1}` : null,
        use_limit,
        expires_at: expires_at || null,
      }));

      const { data, error } = await supabase
        .from('qr_passcodes')
        .insert(rows)
        .select('id, code, customer_label, use_limit');

      if (error) throw error;
      return NextResponse.json({ passcodes: data, generated: count }, { status: 201, headers: QR_CORS });
    }

    // Single passcode path
    const { code, customer_label, use_limit, expires_at } = body;

    if (typeof use_limit !== 'number' || use_limit < 1) {
      return NextResponse.json({ error: 'use_limit must be a positive number' }, { status: 400, headers: QR_CORS });
    }

    const finalCode = (code?.trim() || generatePasscode()).toUpperCase();

    const { data, error } = await supabase
      .from('qr_passcodes')
      .insert({
        qr_id: qrId,
        code: finalCode,
        customer_label: customer_label?.trim() || null,
        use_limit,
        expires_at: expires_at || null,
      })
      .select('id, code, customer_label, use_limit, used_count, active')
      .single();

    if (error) {
      // Unique violation = code already exists for this QR
      if ((error as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'A passcode with this code already exists for this QR' }, { status: 409, headers: QR_CORS });
      }
      throw error;
    }

    return NextResponse.json({ passcode: data }, { status: 201, headers: QR_CORS });
  } catch (error) {
    console.error('[qr/passcodes POST] Error:', error);
    return NextResponse.json({ error: 'Failed to create passcode' }, { status: 500, headers: QR_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: QR_CORS });
}
