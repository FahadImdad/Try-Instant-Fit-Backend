import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const { data, error } = await supabase.from('promotions').select('*, promotion_brands(brand_id)').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Failed to load promotions' }, { status: 500, headers: ADMIN_CORS });
  return NextResponse.json({ promotions: data ?? [] }, { headers: ADMIN_CORS });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim().toUpperCase();
  const discount = Number(body.discountPercent);
  const brandIds = Array.isArray(body.brandIds) ? body.brandIds : [];
  if (!code || !Number.isInteger(discount) || discount < 5 || discount > 50 || discount % 5 !== 0 || !brandIds.length) return NextResponse.json({ error: 'Code, 5%-50% discount, and at least one brand are required' }, { status: 400, headers: ADMIN_CORS });
  const { data: promo, error } = await supabase.from('promotions').insert({ code, discount_percent: discount, active: body.active !== false, starts_at: body.startsAt || null, ends_at: body.endsAt || null }).select().single();
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'Promo code already exists' : 'Failed to create promotion' }, { status: 400, headers: ADMIN_CORS });
  await supabase.from('promotion_brands').insert(brandIds.map((brand_id: string) => ({ promotion_id: promo.id, brand_id })));
  return NextResponse.json({ promotion: promo }, { status: 201, headers: ADMIN_CORS });
}
