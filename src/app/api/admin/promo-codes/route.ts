import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const b = await request.json().catch(() => ({}));
  const discount = Number(b.discountPercent); const brands = Array.isArray(b.brandIds) ? b.brandIds : [];
  if (!b.code?.trim() || !Number.isInteger(discount) || discount < 5 || discount > 50 || discount % 5 || !brands.length) return NextResponse.json({ error: 'Promo code, 5%-50% discount, and brands are required' }, { status: 400, headers: ADMIN_CORS });
  const { data, error } = await supabase.from('promo_codes').insert({ code: b.code.trim().toUpperCase(), discount_percent: discount, active: b.active !== false }).select().single();
  if (error) return NextResponse.json({ error: 'Promo code already exists or could not be created' }, { status: 400, headers: ADMIN_CORS });
  await supabase.from('promo_code_brands').insert(brands.map((brand_id: string) => ({ promo_code_id: data.id, brand_id })));
  return NextResponse.json({ promoCode: data }, { status: 201, headers: ADMIN_CORS });
}

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const { data, error } = await supabase.from('promo_codes').select('*, promo_code_brands(brand_id)').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Failed to load promo codes' }, { status: 500, headers: ADMIN_CORS });
  return NextResponse.json({ promoCodes: data ?? [] }, { headers: ADMIN_CORS });
}
