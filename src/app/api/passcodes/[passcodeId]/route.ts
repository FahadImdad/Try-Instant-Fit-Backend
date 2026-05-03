import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams {
  params: Promise<{ passcodeId: string }>;
}

/**
 * GET /api/passcodes/[passcodeId]
 * Get passcode + all try-ons recorded against it (for sales feedback view).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { passcodeId } = await params;
    const { data: passcode, error } = await supabase
      .from('brand_passcodes')
      .select('*')
      .eq('id', passcodeId)
      .maybeSingle();
    if (error) throw error;
    if (!passcode) return NextResponse.json({ error: 'Passcode not found' }, { status: 404, headers: CORS });

    // All try-ons run with this passcode
    const { data: tryons } = await supabase
      .from('tryons')
      .select('id, product_id, product_uuid, product_name, result_image_url, processing_time_ms, sold, sold_at, sold_price, sold_currency, sold_notes, created_at')
      .eq('brand_passcode_id', passcodeId)
      .order('created_at', { ascending: false });

    return NextResponse.json({ passcode, tryons: tryons ?? [] }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[passcodes/[id] GET]', e);
    return NextResponse.json({ error: 'Failed to load passcode' }, { status: 500, headers: CORS });
  }
}

/**
 * PATCH /api/passcodes/[passcodeId]
 * Update active state, use_limit, expires_at, customer_label.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { passcodeId } = await params;
    const body = await request.json();
    const allowed = ['active', 'use_limit', 'expires_at', 'customer_label'];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in body) update[k] = body[k];

    const { data, error } = await supabase
      .from('brand_passcodes')
      .update(update)
      .eq('id', passcodeId)
      .select('*')
      .single();
    if (error) throw error;
    return NextResponse.json({ passcode: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[passcodes/[id] PATCH]', e);
    return NextResponse.json({ error: 'Failed to update passcode' }, { status: 500, headers: CORS });
  }
}

/**
 * DELETE /api/passcodes/[passcodeId]
 * Soft-delete by default (active=false). ?hard=true for permanent.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { passcodeId } = await params;
    const url = new URL(request.url);
    const hard = url.searchParams.get('hard') === 'true';

    if (hard) {
      const { error } = await supabase.from('brand_passcodes').delete().eq('id', passcodeId);
      if (error) throw error;
      return NextResponse.json({ ok: true, deleted: 'hard' }, { status: 200, headers: CORS });
    }

    const { data, error } = await supabase
      .from('brand_passcodes')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', passcodeId)
      .select('id, active')
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, deleted: 'soft', passcode: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[passcodes/[id] DELETE]', e);
    return NextResponse.json({ error: 'Failed to delete passcode' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
