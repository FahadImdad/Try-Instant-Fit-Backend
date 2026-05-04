import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

/**
 * GET /api/admin/brands
 *   List all brands with credit usage and try-on totals.
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { data: brands, error } = await supabase
      .from('brands')
      .select('id, name, email, website_url, status, tryon_credits, tryon_credits_used, price_per_tryon_usd, unlimited, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ brands: brands ?? [] }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/brands GET]', error);
    return NextResponse.json({ error: 'Failed to load brands' }, { status: 500, headers: ADMIN_CORS });
  }
}

/**
 * POST /api/admin/brands
 *   Create a new brand and optionally link to a contact_submission.
 *   Body: {
 *     name, email, website_url?, status?,
 *     initial_credits?: number, price_per_tryon_usd?: number, unlimited?: boolean,
 *     contact_submission_id?: UUID (if onboarding from a submission),
 *     payment_amount_usd?: number, payment_ref?: string, notes?: string
 *   }
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const {
      name,
      email,
      website_url,
      status = 'pending',
      initial_credits = 0,
      price_per_tryon_usd = 0.125,
      unlimited = false,
      contact_submission_id,
      payment_amount_usd,
      payment_ref,
      notes,
    } = body ?? {};

    if (!name?.trim() || !email?.trim()) {
      return NextResponse.json({ error: 'name and email are required' }, { status: 400, headers: ADMIN_CORS });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check if brand already exists
    const { data: existing } = await supabase
      .from('brands')
      .select('id, name')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: `Brand already exists with this email (id: ${existing.id})` },
        { status: 409, headers: ADMIN_CORS },
      );
    }

    // Create brand
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .insert({
        name: name.trim(),
        email: cleanEmail,
        website_url: website_url?.trim() || null,
        status,
        tryon_credits: initial_credits,
        price_per_tryon_usd,
        unlimited,
      })
      .select('*')
      .single();

    if (brandError) throw brandError;

    // Default widget config
    await supabase.from('widget_configs').insert({
      brand_id: brand.id,
      enabled: true,
      button_text: 'Try It On ✨',
      button_color: '#FF5C35',
      button_position: 'bottom-right',
    });

    // Audit log if initial credits > 0
    if (initial_credits > 0) {
      await supabase.from('brand_credit_topups').insert({
        brand_id: brand.id,
        credits_added: initial_credits,
        amount_usd: payment_amount_usd ?? null,
        payment_ref: payment_ref ?? null,
        notes: notes ?? 'Initial credits at brand creation',
        added_by: 'admin',
      });
    }

    // Link to contact_submission if provided
    if (contact_submission_id) {
      await supabase
        .from('contact_submissions')
        .update({ status: 'converted', brand_id: brand.id, updated_at: new Date().toISOString() })
        .eq('id', contact_submission_id);
    }

    return NextResponse.json({ brand }, { status: 201, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/brands POST]', error);
    const msg = error instanceof Error ? error.message : 'Failed to create brand';
    return NextResponse.json({ error: msg }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
