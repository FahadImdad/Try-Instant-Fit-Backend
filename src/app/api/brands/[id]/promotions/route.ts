import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ data: offers }, { data: codes }] = await Promise.all([
    supabase.from('promotional_offer_brands').select('offer:promotional_offers!inner(id,name,discount_percent,active)').eq('brand_id', id),
    supabase.from('promo_code_brands').select('promo:promo_codes!inner(id,code,name,discount_percent,active)').eq('brand_id', id),
  ]);
  return NextResponse.json({ offers: (offers || []).map((x: any) => x.offer).filter((x: any) => x?.active), promoCodes: (codes || []).map((x: any) => x.promo).filter((x: any) => x?.active) }, { headers: { 'Cache-Control': 'no-store' } });
}
