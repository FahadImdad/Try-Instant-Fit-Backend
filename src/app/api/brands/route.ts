import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, email, website_url } = body ?? {};

    if (!name?.trim() || !email?.trim()) {
      return NextResponse.json({ error: 'name and email are required' }, { status: 400 });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Return existing brand if already registered
    const { data: existing } = await supabase
      .from('brands')
      .select('id, name, email, website_url')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ brand_id: existing.id, name: existing.name, existing: true });
    }

    // Create brand
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .insert({
        name: name.trim(),
        email: cleanEmail,
        website_url: website_url?.trim() || null,
        status: 'trial',
      })
      .select('id, name')
      .single();

    if (brandError) throw brandError;

    // Create default widget config
    await supabase.from('widget_configs').insert({
      brand_id: brand.id,
      enabled: true,
      button_text: 'Try It On ✨',
      button_color: '#FF5C35',
      button_position: 'bottom-right',
    });

    return NextResponse.json({ brand_id: brand.id, name: brand.name, existing: false }, { status: 201 });
  } catch (error) {
    console.error('[brands] Error:', error);
    return NextResponse.json({ error: 'Failed to create brand. Please try again.' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
