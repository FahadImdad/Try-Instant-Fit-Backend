import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_PRODUCTS = ['ghost-layer', 'scan-wear', 'digital-mirror', 'multiple', 'not-sure'];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      email,
      brand_name,
      website_url,
      product_interest,
      message,
    } = body ?? {};

    if (!name?.trim() || !email?.trim() || !brand_name?.trim()) {
      return NextResponse.json(
        { error: 'name, email, and brand_name are required' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    if (product_interest && !VALID_PRODUCTS.includes(product_interest)) {
      return NextResponse.json(
        { error: 'invalid product_interest' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const { data, error } = await supabase
      .from('contact_submissions')
      .insert({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        brand_name: brand_name.trim(),
        website_url: website_url?.trim() || null,
        product_interest: product_interest || null,
        message: message?.trim() || null,
        source: 'website',
      })
      .select('id, created_at')
      .single();

    if (error) throw error;

    return NextResponse.json(
      { ok: true, submission_id: data.id, created_at: data.created_at },
      { status: 201, headers: CORS_HEADERS },
    );
  } catch (error) {
    console.error('[contact] Error:', error);
    return NextResponse.json(
      { error: 'Failed to submit. Please try again or message us on WhatsApp.' },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
