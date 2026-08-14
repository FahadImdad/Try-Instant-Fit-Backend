import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface RouteParams { params: Promise<{ brandId: string }> }

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);
    const { data, error } = await supabase
      .from('customer_tryon_leads')
      .select('id, customer_name, customer_email, customer_phone, followup_consent, access_mode, product_id, qr_id, tryon_id, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return NextResponse.json({ leads: data ?? [] }, { headers: CORS });
  } catch (error) {
    console.error('[brands/leads GET]', error);
    return NextResponse.json({ error: 'Failed to load customer leads' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }
