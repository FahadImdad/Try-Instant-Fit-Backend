import { NextResponse } from 'next/server';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * GET /api/auth/config
 * Returns public auth config (Google OAuth client ID).
 * Client IDs are designed to be public — they're embedded in browser JS.
 */
export async function GET() {
  return NextResponse.json(
    {
      google_client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || null,
      google_enabled: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
    },
    { status: 200, headers: CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
