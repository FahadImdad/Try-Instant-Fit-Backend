import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generatePasscode } from '@/lib/qr';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/passcodes
 * List all brand-wide passcodes (works across any QR for this brand).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const { data, error } = await supabase
      .from('brand_passcodes')
      .select('id, code, customer_label, use_limit, used_count, expires_at, active, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ passcodes: data ?? [] }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[brand passcodes GET]', e);
    return NextResponse.json({ error: 'Failed to load passcodes' }, { status: 500, headers: CORS });
  }
}

/**
 * POST /api/brands/[brandId]/passcodes
 * Create a single brand-wide passcode.
 *
 * Body: { code?, customer_label?, use_limit, expires_at? }
 *   - code: optional. If omitted, auto-generated.
 *   - customer_label: who's it for (e.g. "Sarah K")
 *   - use_limit: positive integer, total tries across all QRs for this brand
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const body = await request.json();
    const { code, customer_label, use_limit, expires_at } = body ?? {};

    if (typeof use_limit !== 'number' || use_limit < 1) {
      return NextResponse.json({ error: 'use_limit must be a positive number' }, { status: 400, headers: CORS });
    }

    // Verify brand
    const { data: brand } = await supabase.from('brands').select('id').eq('id', brandId).maybeSingle();
    if (!brand) return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS });

    const finalCode = (code?.trim() || generatePasscode()).toUpperCase();

    const { data, error } = await supabase
      .from('brand_passcodes')
      .insert({
        brand_id: brandId,
        code: finalCode,
        customer_label: customer_label?.trim() || null,
        use_limit,
        expires_at: expires_at || null,
      })
      .select('id, code, customer_label, use_limit, used_count, expires_at, active, created_at')
      .single();

    if (error) {
      if ((error as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'A passcode with this code already exists for this brand' }, { status: 409, headers: CORS });
      }
      throw error;
    }

    return NextResponse.json({ passcode: data }, { status: 201, headers: CORS });
  } catch (e) {
    console.error('[brand passcodes POST]', e);
    return NextResponse.json({ error: 'Failed to create passcode' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
