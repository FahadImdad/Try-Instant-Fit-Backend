import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';

export async function GET(request: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  const { brandId } = await params;
  const { data, error } = await supabase.from('widget_configs').select('show_platform_logo').eq('brand_id', brandId).single();
  if (error) return NextResponse.json({ showPlatformLogo: true }, { headers: ADMIN_CORS });
  return NextResponse.json({ showPlatformLogo: data?.show_platform_logo !== false }, { headers: ADMIN_CORS });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  const { brandId } = await params;
  const body = await request.json().catch(() => ({}));
  const { data, error } = await supabase.from('widget_configs').update({
    show_platform_logo: body.showPlatformLogo !== false,
    updated_at: new Date().toISOString(),
  }).eq('brand_id', brandId).select('show_platform_logo').single();
  if (error) return NextResponse.json({ error: 'Could not update download branding' }, { status: 400, headers: ADMIN_CORS });
  return NextResponse.json({ showPlatformLogo: data.show_platform_logo }, { headers: ADMIN_CORS });
}
