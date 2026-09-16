import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

const LEVELS = ['info', 'warning', 'success'];
const MAX_TITLE = 120;
const MAX_BODY = 2000;

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const { data, error } = await supabase
    .from('announcements')
    .select('*, announcement_brands(brand_id)')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Failed to load announcements' }, { status: 500, headers: ADMIN_CORS });
  return NextResponse.json({ announcements: data ?? [] }, { headers: ADMIN_CORS });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const b = await request.json().catch(() => ({}));

  const title = (b.title ?? '').trim();
  const body = (b.body ?? '').trim();
  const level = b.level ?? 'info';
  const audience = b.audience === 'selected' ? 'selected' : 'all';
  const brandIds: string[] = Array.isArray(b.brandIds) ? b.brandIds : [];

  if (!title || !body) {
    return NextResponse.json({ error: 'Title and message are required' }, { status: 400, headers: ADMIN_CORS });
  }
  if (title.length > MAX_TITLE || body.length > MAX_BODY) {
    return NextResponse.json({ error: `Title must be under ${MAX_TITLE} characters and the message under ${MAX_BODY}` }, { status: 400, headers: ADMIN_CORS });
  }
  if (!LEVELS.includes(level)) {
    return NextResponse.json({ error: 'Invalid announcement type' }, { status: 400, headers: ADMIN_CORS });
  }
  // A targeted announcement with no recipients would be invisible to everyone,
  // which is a silent no-op rather than an obvious failure — reject it.
  if (audience === 'selected' && !brandIds.length) {
    return NextResponse.json({ error: 'Select at least one brand, or send to all brands' }, { status: 400, headers: ADMIN_CORS });
  }
  if (b.endsAt && b.startsAt && new Date(b.endsAt) <= new Date(b.startsAt)) {
    return NextResponse.json({ error: 'The end date must be after the start date' }, { status: 400, headers: ADMIN_CORS });
  }

  const { data, error } = await supabase
    .from('announcements')
    .insert({
      title,
      body,
      level,
      audience,
      active: b.active !== false,
      starts_at: b.startsAt || null,
      ends_at: b.endsAt || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: 'Could not create the announcement' }, { status: 500, headers: ADMIN_CORS });

  if (audience === 'selected') {
    const { error: linkError } = await supabase
      .from('announcement_brands')
      .insert(brandIds.map((brand_id: string) => ({ announcement_id: data.id, brand_id })));
    // Without its recipients the announcement reaches nobody, so don't leave a
    // half-created row behind claiming to be sent.
    if (linkError) {
      await supabase.from('announcements').delete().eq('id', data.id);
      return NextResponse.json({ error: 'Could not assign the selected brands' }, { status: 500, headers: ADMIN_CORS });
    }
  }

  return NextResponse.json({ announcement: data }, { status: 201, headers: ADMIN_CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: ADMIN_CORS });
}
