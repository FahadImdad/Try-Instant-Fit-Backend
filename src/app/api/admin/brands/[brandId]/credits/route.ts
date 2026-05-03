import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * POST /api/admin/brands/[brandId]/credits
 *   Add try-on credits to a brand. Logs to brand_credit_topups for audit.
 *
 *   Body: {
 *     credits_added: number (required, > 0),
 *     amount_usd?: number (optional, what the brand paid),
 *     payment_ref?: string (e.g. bank ref, invoice number),
 *     notes?: string,
 *   }
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { brandId } = await params;
    const body = await request.json();
    const { credits_added, amount_usd, payment_ref, notes } = body ?? {};

    if (typeof credits_added !== 'number' || credits_added <= 0) {
      return NextResponse.json(
        { error: 'credits_added must be a positive number' },
        { status: 400, headers: ADMIN_CORS },
      );
    }

    // Atomically increment tryon_credits
    const { data: brand, error: fetchError } = await supabase
      .from('brands')
      .select('tryon_credits')
      .eq('id', brandId)
      .single();

    if (fetchError || !brand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: ADMIN_CORS });
    }

    const { data: updated, error: updateError } = await supabase
      .from('brands')
      .update({
        tryon_credits: (brand.tryon_credits || 0) + credits_added,
        updated_at: new Date().toISOString(),
      })
      .eq('id', brandId)
      .select('id, tryon_credits, tryon_credits_used, price_per_tryon_usd, unlimited')
      .single();

    if (updateError) throw updateError;

    // Log to topups
    await supabase.from('brand_credit_topups').insert({
      brand_id: brandId,
      credits_added,
      amount_usd: amount_usd ?? null,
      payment_ref: payment_ref ?? null,
      notes: notes ?? null,
      added_by: 'admin',
    });

    return NextResponse.json({ brand: updated }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/brands/[brandId]/credits POST]', error);
    return NextResponse.json({ error: 'Failed to add credits' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
