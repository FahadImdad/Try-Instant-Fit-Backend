import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

/**
 * GET /api/admin/contact-submissions
 *   List all contact submissions, newest first. Optional ?status= filter.
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let q = supabase
      .from('contact_submissions')
      .select('id, name, email, brand_name, website_url, product_interest, message, status, source, brand_id, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    return NextResponse.json({ submissions: data ?? [] }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/contact-submissions GET]', error);
    return NextResponse.json({ error: 'Failed to load submissions' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
