import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams {
  params: Promise<{ productId: string }>;
}

/**
 * GET /api/products/[productId]
 * Single product detail.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { productId } = await params;
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Product not found' }, { status: 404, headers: CORS });
    return NextResponse.json({ product: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[products/[productId] GET]', e);
    return NextResponse.json({ error: 'Failed to load product' }, { status: 500, headers: CORS });
  }
}

/**
 * PATCH /api/products/[productId]
 * Update fields (name, price, currency, description, active).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { productId } = await params;
    const body = await request.json();
    const allowed = ['name', 'sku', 'price', 'currency', 'description', 'active'];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in body) update[k] = body[k];

    const { data, error } = await supabase
      .from('products')
      .update(update)
      .eq('id', productId)
      .select('*')
      .single();
    if (error) throw error;
    return NextResponse.json({ product: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[products/[productId] PATCH]', e);
    return NextResponse.json({ error: 'Failed to update product' }, { status: 500, headers: CORS });
  }
}

/**
 * DELETE /api/products/[productId]
 * Soft-delete (set active=false). Add ?hard=true for permanent delete.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { productId } = await params;
    const url = new URL(request.url);
    const hard = url.searchParams.get('hard') === 'true';

    if (hard) {
      const { error } = await supabase.from('products').delete().eq('id', productId);
      if (error) throw error;
      return NextResponse.json({ ok: true, deleted: 'hard' }, { status: 200, headers: CORS });
    }

    const { data, error } = await supabase
      .from('products')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .select('id, active')
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, deleted: 'soft', product: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[products/[productId] DELETE]', e);
    return NextResponse.json({ error: 'Failed to delete product' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
