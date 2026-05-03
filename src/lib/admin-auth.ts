import { NextRequest, NextResponse } from 'next/server';

export const ADMIN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Check Basic Auth credentials against ADMIN_USERNAME/ADMIN_PASSWORD env vars.
 * Returns null if OK, or a 401 NextResponse if not.
 *
 * Use at the top of every admin route handler:
 *   const unauthorized = requireAdminAuth(request);
 *   if (unauthorized) return unauthorized;
 */
export function requireAdminAuth(request: NextRequest): NextResponse | null {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPass) {
    return NextResponse.json(
      { error: 'Admin auth is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD env vars.' },
      { status: 500, headers: ADMIN_CORS },
    );
  }

  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401, headers: { ...ADMIN_CORS, 'WWW-Authenticate': 'Basic realm="TryInstantFit Admin"' } },
    );
  }

  let user = '';
  let pass = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return NextResponse.json(
      { error: 'Malformed authorization header' },
      { status: 401, headers: ADMIN_CORS },
    );
  }

  // Constant-time comparison to prevent timing attacks
  if (!constantTimeEqual(user, expectedUser) || !constantTimeEqual(pass, expectedPass)) {
    return NextResponse.json(
      { error: 'Invalid credentials' },
      { status: 401, headers: ADMIN_CORS },
    );
  }

  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
