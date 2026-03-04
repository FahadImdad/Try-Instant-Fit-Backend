import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

// GET /api/brands/lookup?email=you@brand.com
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get('email')?.toLowerCase().trim();

  if (!email) {
    return NextResponse.json({ error: 'email query param is required' }, { status: 400 });
  }

  try {
    const { data: brand } = await supabase
      .from('brands')
      .select('id, name, website_url')
      .eq('email', email)
      .maybeSingle();

    if (!brand) {
      return NextResponse.json({ error: 'No brand found for that email' }, { status: 404 });
    }

    return NextResponse.json({ brand_id: brand.id, name: brand.name, website_url: brand.website_url });
  } catch (error) {
    console.error('[lookup] Error:', error);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
