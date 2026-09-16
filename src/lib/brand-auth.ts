import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * Brand dashboard authentication.
 *
 * A brand's own data used to be reachable with nothing but its brand_id,
 * which travels in URLs and localStorage and is not a secret. These helpers
 * issue a signed, expiring token at login and verify it on every
 * brand-scoped route.
 *
 * Admin Basic Auth is accepted everywhere a brand token is, so the admin
 * console keeps full access to every brand's dashboard.
 *
 * Customer-facing routes (scan, catalog, QR try-on) are deliberately NOT
 * covered by this — shoppers have no login and those paths must stay open.
 */

// A vendor stays signed in on the same device for a week, across tab and
// browser closes — they should not be asked again during normal daily use.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Admin tokens carry no expiry at all — see issueBrandToken. They are minted
// only behind admin Basic Auth, and those credentials already grant access to
// every brand, so a long-lived token gives nothing that could not be obtained
// again in a single request.

export const BRAND_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function secret(): string {
  // Fall back to the service-role key so the feature cannot silently degrade
  // into "no signature" if a dedicated secret was never configured.
  const s = process.env.BRAND_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('BRAND_SESSION_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is required');
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a session token for a brand. `scope` records how it was obtained;
 * 'admin' tokens are short-lived because they are handed out by the admin
 * console to open a vendor dashboard.
 */
export function issueBrandToken(brandId: string, scope: 'brand' | 'admin' = 'brand'): string {
  // 'never' rather than a number for admin, so the expiry check has an
  // explicit case instead of depending on how Infinity round-trips.
  const expires = scope === 'admin' ? 'never' : String(Date.now() + TOKEN_TTL_MS);
  const payload = `${brandId}.${expires}.${scope}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function verifyBrandToken(token: string, brandId: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  // Reject before parsing anything if the signature does not match, so a
  // forged payload never reaches the comparisons below.
  if (!constantTimeEqual(sign(payload), signature)) return false;

  const [tokenBrandId, expiresRaw] = payload.split('.');
  if (!tokenBrandId) return false;

  // Admin tokens never expire; everything else must carry a real timestamp.
  // The signature was already verified above, so 'never' cannot be forged.
  if (expiresRaw !== 'never') {
    const expires = Number(expiresRaw);
    if (!Number.isFinite(expires)) return false;
    if (Date.now() > expires) return false;
  }

  // A valid token for one brand must not unlock another.
  return constantTimeEqual(tokenBrandId, brandId);
}

function adminCredentialsValid(request: NextRequest): boolean {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) return false;

  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    return constantTimeEqual(decoded.slice(0, idx), expectedUser)
        && constantTimeEqual(decoded.slice(idx + 1), expectedPass);
  } catch {
    return false;
  }
}

/**
 * Guard a brand-scoped route. Returns null when the caller may proceed, or a
 * 401 response to return as-is.
 *
 * Accepts either:
 *   - Authorization: Bearer <brand token>  matching this brandId, or
 *   - Authorization: Basic <admin creds>   (admin sees every brand)
 */
export function requireBrandAuth(request: NextRequest, brandId: string): NextResponse | null {
  const header = request.headers.get('authorization') || '';

  if (header.startsWith('Bearer ') && verifyBrandToken(header.slice(7).trim(), brandId)) {
    return null;
  }

  if (adminCredentialsValid(request)) return null;

  return NextResponse.json(
    { error: 'Please sign in to view this dashboard.', code: 'AUTH_REQUIRED' },
    { status: 401, headers: BRAND_CORS },
  );
}
