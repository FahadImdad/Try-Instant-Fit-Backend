import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * PATCH /api/brands/[brandId]
 *
 * Brand self-service profile edit. The brand can update its own
 * display fields. Email (auth identity), credits, status, pricing,
 * and other admin-controlled fields are intentionally NOT writable
 * here — those live on the admin endpoint.
 *
 * Allowed fields: name, website_url, logo_url, primary_color,
 * contact_name, contact_position, contact_phone, country.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const body = await request.json();

    const allowed = [
      'name',
      'website_url',
      'logo_url',
      'primary_color',
      'contact_name',
      'contact_position',
      'contact_phone',
      'country',
    ];
    const update: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in body) {
        const v = body[k];
        // Empty strings are converted to null so the brand can
        // intentionally clear an optional field.
        update[k] = typeof v === 'string' ? (v.trim() || null) : v;
      }
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No editable fields provided' }, { status: 400, headers: CORS });
    }
    update.updated_at = new Date().toISOString();

    if ('name' in update && !update.name) {
      return NextResponse.json({ error: 'Brand name cannot be empty' }, { status: 400, headers: CORS });
    }

    const { data, error } = await supabase
      .from('brands')
      .update(update)
      .eq('id', brandId)
      .select('*')
      .single();
    if (error) {
      console.error('[brands PATCH]', error);
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500, headers: CORS });
    }
    if (!data) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS });
    }
    return NextResponse.json({ brand: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[brands PATCH]', e);
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
