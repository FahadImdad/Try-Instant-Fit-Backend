import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { uploadBrandLogo } from '@/lib/storage';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_LOGO_SIZE = 5 * 1024 * 1024;
const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];

/**
 * POST /api/brands/register
 * Public self-registration. Brand fills out details + uploads logo.
 * Creates brand with status='pending', tryon_credits=0.
 *
 * Multipart form fields:
 *   name, email, website_url?, contact_phone?, country (PK default),
 *   primary_color?, logo (file)
 */
export async function POST(request: NextRequest) {
  try {
    const ct = request.headers.get('content-type') || '';
    let body: Record<string, unknown> = {};
    let logoFile: File | null = null;

    if (ct.includes('multipart/form-data')) {
      const fd = await request.formData();
      logoFile = fd.get('logo') as File | null;
      body = {
        name: fd.get('name'),
        email: fd.get('email'),
        website_url: fd.get('website_url'),
        contact_phone: fd.get('contact_phone'),
        country: fd.get('country') || 'PK',
        primary_color: fd.get('primary_color') || '#5a67f2',
      };
    } else {
      body = await request.json();
    }

    const { name, email, website_url, contact_phone, country, primary_color } = body as {
      name?: string; email?: string; website_url?: string; contact_phone?: string;
      country?: string; primary_color?: string;
    };

    if (!name?.trim() || !email?.trim()) {
      return NextResponse.json({ error: 'name and email are required' }, { status: 400, headers: CORS });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Already registered?
    const { data: existing } = await supabase
      .from('brands')
      .select('id, status')
      .eq('email', cleanEmail)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: 'A brand with this email already exists. Please log into your dashboard.', existing_brand_id: existing.id },
        { status: 409, headers: CORS },
      );
    }

    // Create brand
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .insert({
        name: name.trim(),
        email: cleanEmail,
        website_url: website_url?.trim() || null,
        contact_phone: contact_phone?.trim() || null,
        country: country || 'PK',
        primary_color: primary_color || '#5a67f2',
        status: 'pending',
        tryon_credits: 0,
      })
      .select('*')
      .single();
    if (brandError) throw brandError;

    // Upload logo (best-effort)
    let logoUrl: string | null = null;
    if (logoFile && logoFile.size > 0) {
      if (!ALLOWED_LOGO_TYPES.includes(logoFile.type)) {
        // Brand created — just skip logo upload
        console.warn('[register] Invalid logo type:', logoFile.type);
      } else if (logoFile.size > MAX_LOGO_SIZE) {
        console.warn('[register] Logo too large:', logoFile.size);
      } else {
        try {
          const buf = Buffer.from(await logoFile.arrayBuffer());
          logoUrl = await uploadBrandLogo(buf, brand.id, logoFile.type);
          await supabase.from('brands').update({ logo_url: logoUrl }).eq('id', brand.id);
        } catch (e) {
          console.error('[register] Logo upload failed:', e);
        }
      }
    }

    // Default widget config
    await supabase.from('widget_configs').insert({
      brand_id: brand.id,
      enabled: true,
      button_text: 'Try It On ✨',
      button_color: primary_color || '#5a67f2',
      button_position: 'bottom-right',
    });

    return NextResponse.json(
      {
        brand_id: brand.id,
        name: brand.name,
        status: brand.status,
        logo_url: logoUrl,
        message: 'Registration received. Top up credits to start using try-on.',
      },
      { status: 201, headers: CORS },
    );
  } catch (e) {
    console.error('[brands/register]', e);
    const msg = e instanceof Error ? e.message : 'Failed to register';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
