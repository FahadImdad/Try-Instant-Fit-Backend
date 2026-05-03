import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * POST /api/brands/auth/google
 * Verifies a Google ID token and signs the user into their brand dashboard.
 *
 * Body: { id_token: string }
 *
 * On success:
 *   - 200 with { brand_id, name, email, status, ... } if brand exists
 *   - 404 with { error, email, name, register_url } if no brand registered with this email
 *
 * The ID token is a JWT signed by Google. We verify it cryptographically
 * with Google's public keys (handled by google-auth-library).
 */
export async function POST(request: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID env var.' },
      { status: 500, headers: CORS },
    );
  }

  try {
    const body = await request.json();
    const { id_token } = body ?? {};
    if (!id_token) {
      return NextResponse.json({ error: 'id_token is required' }, { status: 400, headers: CORS });
    }

    // Verify the token with Google
    const client = new OAuth2Client(clientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken: id_token,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      console.error('[google auth] Invalid token:', err);
      return NextResponse.json({ error: 'Invalid Google token' }, { status: 401, headers: CORS });
    }

    if (!payload?.email) {
      return NextResponse.json({ error: 'Google account has no email' }, { status: 400, headers: CORS });
    }
    if (!payload.email_verified) {
      return NextResponse.json({ error: 'Email is not verified by Google' }, { status: 400, headers: CORS });
    }

    const email = payload.email.toLowerCase().trim();
    const name = payload.name || payload.given_name || '';
    const picture = payload.picture || null;

    // Look up brand by email
    const { data: brand } = await supabase
      .from('brands')
      .select('id, name, email, website_url, status, tryon_credits, tryon_credits_used, price_per_tryon_usd, unlimited, logo_url, country, primary_color, created_at')
      .eq('email', email)
      .maybeSingle();

    if (!brand) {
      return NextResponse.json(
        {
          error: 'No brand registered with this email.',
          email,
          name,
          picture,
          register_url: '/register',
        },
        { status: 404, headers: CORS },
      );
    }

    return NextResponse.json(
      {
        brand_id: brand.id,
        name: brand.name,
        email: brand.email,
        status: brand.status,
        google_picture: picture,
      },
      { status: 200, headers: CORS },
    );
  } catch (e) {
    console.error('[google auth] Error:', e);
    return NextResponse.json({ error: 'Sign-in failed' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
