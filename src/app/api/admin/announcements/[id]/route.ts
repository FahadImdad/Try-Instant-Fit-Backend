import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

const LEVELS = ['info', 'warning', 'success'];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const { id } = await params;
  const b = await request.json().catch(() => ({}));

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof b.title === 'string')  update.title = b.title.trim();
  if (typeof b.body === 'string')   update.body = b.body.trim();
  if (typeof b.active === 'boolean') update.active = b.active;
  if (b.level && LEVELS.includes(b.level)) update.level = b.level;
  if ('startsAt' in b) update.starts_at = b.startsAt || null;
  if ('endsAt' in b)   update.ends_at = b.endsAt || null;

  if (update.title === '' || update.body === '') {
    return NextResponse.json({ error: 'Title and message cannot be empty' }, { status: 400, headers: ADMIN_CORS });
  }

  const { data, error } = await supabase
    .from('announcements')
    .update(update)
    .eq('id', id)
    .select('*, announcement_brands(brand_id)')
    .single();

  if (error || !data) return NextResponse.json({ error: 'Could not update the announcement' }, { status: 500, headers: ADMIN_CORS });

  // Recipients were changed: replace the set wholesale so removed brands stop
  // seeing it.
  if (Array.isArray(b.brandIds)) {
    await supabase.from('announcement_brands').delete().eq('announcement_id', id);
    if (b.brandIds.length) {
      await supabase
        .from('announcement_brands')
        .insert(b.brandIds.map((brand_id: string) => ({ announcement_id: id, brand_id })));
    }
  }

  return NextResponse.json({ announcement: data }, { headers: ADMIN_CORS });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const { id } = await params;
  // announcement_brands and announcement_dismissals cascade.
  const { error } = await supabase.from('announcements').delete().eq('id', id);
  if (error) return NextResponse.json({ error: 'Could not delete the announcement' }, { status: 500, headers: ADMIN_CORS });
  return NextResponse.json({ ok: true }, { headers: ADMIN_CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: ADMIN_CORS });
}
