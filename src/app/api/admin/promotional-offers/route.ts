import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const b = await request.json().catch(() => ({}));
  const discount = Number(b.discountPercent); const brands = Array.isArray(b.brandIds) ? b.brandIds : [];
  if (!b.name?.trim() || !Number.isInteger(discount) || discount < 5 || discount > 50 || discount % 5 || !brands.length) return NextResponse.json({ error: 'Offer name, 5%-50% discount, and brands are required' }, { status: 400, headers: ADMIN_CORS });
  const { data, error } = await supabase.from('promotional_offers').insert({ name: b.name.trim(), discount_percent: discount, active: b.active !== false }).select().single();
  if (error) return NextResponse.json({ error: 'Could not create offer' }, { status: 400, headers: ADMIN_CORS });
  await supabase.from('promotional_offer_brands').insert(brands.map((brand_id: string) => ({ offer_id: data.id, brand_id })));
  return NextResponse.json({ offer: data }, { status: 201, headers: ADMIN_CORS });
}
