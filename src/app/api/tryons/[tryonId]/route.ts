import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams {
  params: Promise<{ tryonId: string }>;
}

/**
 * PATCH /api/tryons/[tryonId]
 * Mark a try-on as sold or update sale info.
 *
 * Body: {
 *   sold?: boolean,
 *   sold_price?: number,
 *   sold_currency?: string,
 *   sold_notes?: string,
 * }
 *
 * When sold transitions false → true, sold_at gets stamped automatically.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { tryonId } = await params;
    const body = await request.json();

    const update: Record<string, unknown> = {};
    if (typeof body.sold === 'boolean') {
      update.sold = body.sold;
      // Stamp sold_at when marking sold; clear when un-marking
      update.sold_at = body.sold ? new Date().toISOString() : null;
    }
    if ('sold_price' in body) {
      update.sold_price = body.sold_price === null || body.sold_price === undefined ? null : Number(body.sold_price);
    }
    if ('sold_currency' in body) {
      update.sold_currency = body.sold_currency || null;
    }
    if ('sold_notes' in body) {
      update.sold_notes = body.sold_notes?.trim() || null;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400, headers: CORS });
    }

    const { data, error } = await supabase
      .from('tryons')
      .update(update)
      .eq('id', tryonId)
      .select('id, sold, sold_at, sold_price, sold_currency, sold_notes')
      .single();

    if (error) throw error;
    return NextResponse.json({ tryon: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[tryons/[id] PATCH]', e);
    return NextResponse.json({ error: 'Failed to update try-on' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
