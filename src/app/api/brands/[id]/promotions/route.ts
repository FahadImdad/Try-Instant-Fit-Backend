import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ data: offerLinks }, { data: codeLinks }] = await Promise.all([
    supabase.from('promotional_offer_brands').select('offer_id').eq('brand_id', id),
    supabase.from('promo_code_brands').select('promo_code_id').eq('brand_id', id),
  ]);
  const offerIds = (offerLinks || []).map(x => x.offer_id).filter(Boolean);
  const codeIds = (codeLinks || []).map(x => x.promo_code_id).filter(Boolean);
  const [{ data: offers }, { data: codes }] = await Promise.all([
    offerIds.length ? supabase.from('promotional_offers').select('id,name,discount_percent,active').in('id', offerIds) : Promise.resolve({ data: [] }),
    codeIds.length ? supabase.from('promo_codes').select('id,code,discount_percent,active').in('id', codeIds) : Promise.resolve({ data: [] }),
  ]);
  return NextResponse.json({ offers: (offers || []).filter(x => x.active), promoCodes: codes || [] }, { headers: { 'Cache-Control': 'no-store' } });
}
