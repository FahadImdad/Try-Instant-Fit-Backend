import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
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
 * Public self-registration. Brand verifies via Google OAuth (preferred) OR
 * provides email directly (legacy). Creates brand with status='pending',
 * tryon_credits=0.
 *
 * Multipart form fields:
 *   google_id_token? — if provided, email is extracted server-side
 *   email? — fallback if no Google token
 *   name, website_url?, contact_phone?, country (PK default),
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
        google_id_token: fd.get('google_id_token'),
        name: fd.get('name'),
        email: fd.get('email'),
        website_url: fd.get('website_url'),
        contact_phone: fd.get('contact_phone'),
        contact_name: fd.get('contact_name'),
        contact_position: fd.get('contact_position'),
        country: fd.get('country') || 'PK',
        primary_color: fd.get('primary_color') || '#5a67f2',
      };
    } else {
      body = await request.json();
    }

    const {
      google_id_token,
      name,
      email: rawEmail,
      website_url,
      contact_phone,
      contact_name,
      contact_position,
      country,
      primary_color,
    } = body as {
      google_id_token?: string;
      name?: string; email?: string; website_url?: string; contact_phone?: string;
      contact_name?: string; contact_position?: string;
      country?: string; primary_color?: string;
    };

    if (!name?.trim()) {
      return NextResponse.json({ error: 'Brand name is required' }, { status: 400, headers: CORS });
    }
    if (!contact_name?.trim()) {
      return NextResponse.json({ error: 'Your name is required' }, { status: 400, headers: CORS });
    }
    if (!contact_position?.trim()) {
      return NextResponse.json({ error: 'Your position is required' }, { status: 400, headers: CORS });
    }
    if (!contact_phone?.trim()) {
      return NextResponse.json({ error: 'WhatsApp number is required' }, { status: 400, headers: CORS });
    }
    if (!website_url?.trim()) {
      return NextResponse.json({ error: 'Website URL is required' }, { status: 400, headers: CORS });
    }
    if (!country?.trim()) {
      return NextResponse.json({ error: 'Country is required' }, { status: 400, headers: CORS });
    }
    if (!logoFile || logoFile.size === 0) {
      return NextResponse.json({ error: 'Brand logo is required' }, { status: 400, headers: CORS });
    }

    // ── Validation ─────────────────────────────────────────────────────────
    const phone = contact_phone.trim();
    if (!/^\+?[\d\s\-()]{7,25}$/.test(phone)) {
      return NextResponse.json({ error: 'Phone number format is invalid' }, { status: 400, headers: CORS });
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return NextResponse.json({ error: 'Phone number must be 7–15 digits' }, { status: 400, headers: CORS });
    }
    try {
      const parsed = new URL(website_url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return NextResponse.json({ error: 'Website URL must start with http:// or https://' }, { status: 400, headers: CORS });
      }
    } catch {
      return NextResponse.json({ error: 'Website URL is not valid' }, { status: 400, headers: CORS });
    }
    if (primary_color && !/^#[0-9a-fA-F]{6}$/.test(primary_color)) {
      return NextResponse.json({ error: 'Brand color must be a 6-digit hex (e.g. #5a67f2)' }, { status: 400, headers: CORS });
    }
    if (!ALLOWED_LOGO_TYPES.includes(logoFile.type)) {
      return NextResponse.json({ error: 'Logo must be JPEG, PNG, WebP, or SVG' }, { status: 400, headers: CORS });
    }
    if (logoFile.size > MAX_LOGO_SIZE) {
      return NextResponse.json({ error: 'Logo must be 5MB or smaller' }, { status: 400, headers: CORS });
    }

    // Resolve email: prefer Google-verified token, fall back to plain field
    let resolvedEmail: string | null = null;
    if (google_id_token) {
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      if (!clientId) {
        return NextResponse.json({ error: 'Google sign-in is not configured' }, { status: 500, headers: CORS });
      }
      try {
        const client = new OAuth2Client(clientId);
        const ticket = await client.verifyIdToken({ idToken: google_id_token, audience: clientId });
        const payload = ticket.getPayload();
        if (!payload?.email || !payload.email_verified) {
          return NextResponse.json({ error: 'Google email not verified' }, { status: 400, headers: CORS });
        }
        resolvedEmail = payload.email.toLowerCase().trim();
      } catch (err) {
        console.error('[register] Invalid Google token:', err);
        return NextResponse.json({ error: 'Invalid Google sign-in. Please retry.' }, { status: 401, headers: CORS });
      }
    } else if (rawEmail?.trim()) {
      resolvedEmail = rawEmail.toLowerCase().trim();
    }

    if (!resolvedEmail) {
      return NextResponse.json({ error: 'Sign in with Google or provide email' }, { status: 400, headers: CORS });
    }

    const cleanEmail = resolvedEmail;

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
        contact_name: contact_name?.trim() || null,
        contact_position: contact_position?.trim() || null,
        country: country || 'PK',
        primary_color: primary_color || '#5a67f2',
        status: 'pending',
        tryon_credits: 0,
      })
      .select('*')
      .single();
    if (brandError) throw brandError;

    // Upload logo (validated above — best-effort against storage errors)
    let logoUrl: string | null = null;
    try {
      const buf = Buffer.from(await logoFile.arrayBuffer());
      logoUrl = await uploadBrandLogo(buf, brand.id, logoFile.type);
      await supabase.from('brands').update({ logo_url: logoUrl }).eq('id', brand.id);
    } catch (e) {
      console.error('[register] Logo upload failed:', e);
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
