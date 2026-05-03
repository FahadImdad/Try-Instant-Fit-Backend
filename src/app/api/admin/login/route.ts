import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

/**
 * POST /api/admin/login
 * Validates Basic Auth header. Returns 200 on success, 401 on failure.
 * The frontend uses this to verify creds, then stores the Basic header
 * in sessionStorage and sends it on every subsequent admin request.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json({ ok: true }, { status: 200, headers: ADMIN_CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
