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

    // Attach each try-on's product imagery. result_image_url is the generated
    // try-on, which is never retained, so on its own every row renders as a
    // placeholder. The product's own image is what identifies the article —
    // the same picture the product card and the analytics leaderboard show.
    const rows = tryons ?? [];
    const skus = [...new Set(rows.map(t => t.product_id).filter(Boolean))] as string[];

    const [{ data: products }, { data: garments }] = await Promise.all([
      supabase
        .from('products')
        .select('id, sku, name, price, currency, image_url, isolated_garment_url')
        .eq('brand_id', passcode.brand_id),
      // Legacy fallback for products created before the products table.
      skus.length
        ? supabase
            .from('product_garments')
            .select('product_id, isolated_garment_url')
            .eq('brand_id', passcode.brand_id)
            .in('product_id', skus)
        : Promise.resolve({ data: [] as { product_id: string; isolated_garment_url: string | null }[] }),
    ]);

    const byUuid = new Map((products ?? []).map(p => [p.id, p]));
    const bySku  = new Map((products ?? []).map(p => [p.sku, p]));
    const legacyBySku = new Map((garments ?? []).map(g => [g.product_id, g.isolated_garment_url]));

    const enriched = rows.map(t => {
      const p = (t.product_uuid ? byUuid.get(t.product_uuid) : undefined)
             ?? (t.product_id ? bySku.get(t.product_id) : undefined)
             ?? null;
      return {
        ...t,
        // Prefer the isolated garment (what the leaderboard shows), then the
        // uploaded product photo, then the legacy garment record.
        product_image_url: p?.isolated_garment_url || p?.image_url
          || (t.product_id ? legacyBySku.get(t.product_id) : null) || null,
        // The canonical product uuid, so the dashboard can open the right
        // product card even when the try-on only recorded a SKU.
        resolved_product_uuid: p?.id ?? t.product_uuid ?? null,
        product_price: p?.price ?? null,
        product_currency: p?.currency ?? null,
      };
    });

    return NextResponse.json({ passcode, tryons: enriched }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[passcodes/[id] GET]', e);
    return NextResponse.json({ error: 'Failed to load passcode' }, { status: 500, headers: CORS });
  }
}

/**
 * PATCH /api/passcodes/[passcodeId]
 * Update metadata and/or add uses. Existing lifetime usage is never replaced.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { passcodeId } = await params;
    const body = await request.json();
    const allowed = ['code', 'active', 'expires_at', 'customer_label'];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in body) update[k] = body[k];

    if ('code' in update) {
      const raw = String(update.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,32}$/.test(raw)) {
        return NextResponse.json(
          { error: 'Code must be 3–32 characters: letters, digits, underscore, or hyphen' },
          { status: 400, headers: CORS },
        );
      }
      update.code = raw;
    }

    if ('use_limit' in body) {
      return NextResponse.json(
        { error: 'Use additional_uses to add try-ons; the lifetime limit cannot be replaced.' },
        { status: 400, headers: CORS },
      );
    }

    let incremented: unknown = null;
    if ('additional_uses' in body) {
      // The dashboard sends the delta between current and desired remaining
      // credits: 0 when only the label or code changed, negative when the
      // vendor lowers the allowance. Rejecting anything below 1 meant an edit
      // that did not touch credits failed with a 400 and saved nothing.
      // add_passcode_uses clamps a decrease so used credits stay protected.
      const additional = Number(body.additional_uses);
      if (!Number.isInteger(additional) || additional < -100000 || additional > 100000) {
        return NextResponse.json({ error: 'Try-on change must be a whole number between -100000 and 100000' }, { status: 400, headers: CORS });
      }
      const { data, error } = await supabase.rpc('add_passcode_uses', {
        p_passcode_id: passcodeId,
        p_additional_uses: additional,
      });
      if (error) throw error;
      incremented = data;
    }

    const hasMetadataUpdate = Object.keys(update).length > 1;
    if (!hasMetadataUpdate) {
      return NextResponse.json({ passcode: incremented }, { status: 200, headers: CORS });
    }

    const { data, error } = await supabase
      .from('brand_passcodes')
      .update(update)
      .eq('id', passcodeId)
      .select('*')
      .single();
    if (error) {
      const pgErr = error as { code?: string; message?: string };
      if (pgErr.code === '23505') {
        return NextResponse.json(
          { error: 'A passcode with this code already exists for this brand' },
          { status: 409, headers: CORS },
        );
      }
      throw error;
    }
    return NextResponse.json({ passcode: data }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[passcodes/[id] PATCH]', e);
    const msg = e instanceof Error ? e.message
      : (e && typeof e === 'object' && 'message' in e) ? String((e as { message: unknown }).message)
      : 'Failed to update passcode';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
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
