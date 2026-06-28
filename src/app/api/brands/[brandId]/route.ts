import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { uploadBrandLogo } from '@/lib/storage';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5MB

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
 * Two content types are supported:
 *   - application/json    text fields only
 *   - multipart/form-data text fields + an optional `logo` file
 *
 * Allowed text fields: name, website_url, logo_url, primary_color,
 *   contact_name, contact_position, contact_phone, country.
 *   `logo_url` is overwritten when a `logo` file is uploaded.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const ct = request.headers.get('content-type') || '';

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
    let logoFile: File | null = null;

    if (ct.includes('multipart/form-data')) {
      const fd = await request.formData();
      for (const k of allowed) {
        if (fd.has(k)) {
          const v = fd.get(k);
          if (typeof v === 'string') {
            update[k] = v.trim() || null;
          }
        }
      }
      const f = fd.get('logo');
      if (f instanceof File && f.size > 0) logoFile = f;
    } else if (ct.includes('application/json')) {
      const body = await request.json();
      for (const k of allowed) {
        if (k in body) {
          const v = body[k];
          update[k] = typeof v === 'string' ? (v.trim() || null) : v;
        }
      }
    } else {
      return NextResponse.json(
        { error: 'Content-Type must be application/json or multipart/form-data' },
        { status: 400, headers: CORS }
      );
    }

    // Upload logo (replaces logo_url) before the DB update so we save the new URL.
    if (logoFile) {
      if (!ALLOWED_LOGO_TYPES.includes(logoFile.type)) {
        return NextResponse.json({ error: 'Logo must be JPG, PNG, WebP, or SVG' }, { status: 400, headers: CORS });
      }
      if (logoFile.size > MAX_LOGO_SIZE) {
        return NextResponse.json({ error: 'Logo must be under 5MB' }, { status: 400, headers: CORS });
      }
      // Isolate storage failures: a logo-upload error must not sink the whole
      // profile save (text fields would otherwise be lost too). Report it as its
      // own clear, human-safe message instead of the generic "Failed to update
      // profile" the outer catch would produce.
      try {
        const buf = Buffer.from(await logoFile.arrayBuffer());
        update.logo_url = await uploadBrandLogo(buf, brandId, logoFile.type);
      } catch (logoErr) {
        console.error('[brands PATCH] logo upload failed', logoErr);
        return NextResponse.json(
          { error: "We couldn't upload that logo. Your other changes weren't saved — please try again, or save without changing the logo." },
          { status: 502, headers: CORS }
        );
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
