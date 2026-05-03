import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/contact-submissions/[id]
 *   Update status or link to a brand_id.
 *   Body: { status?: 'new'|'contacted'|'qualified'|'converted'|'rejected', brand_id?: UUID }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const body = await request.json();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status) update.status = body.status;
    if (body.brand_id !== undefined) update.brand_id = body.brand_id;

    const { data, error } = await supabase
      .from('contact_submissions')
      .update(update)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ submission: data }, { status: 200, headers: ADMIN_CORS });
  } catch (error) {
    console.error('[admin/contact-submissions PATCH]', error);
    return NextResponse.json({ error: 'Failed to update' }, { status: 500, headers: ADMIN_CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ADMIN_CORS });
}
