import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const DEFAULT_CONFIG = {
  enabled: true,
  buttonText: 'Try It On ✨',
  buttonColor: '#1a1a2e',
  buttonPosition: 'bottom-right' as const,
  showPlatformLogo: true,
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ brandId: string }> }
) {
  const { brandId } = await params;

  try {
    // Check brand is active
    const { data: brand } = await supabase
      .from('brands')
      .select('id, status')
      .eq('id', brandId)
      .single();

    // Active is the only status that gates the widget on. Brands that
    // haven't paid yet sit at 'pending' until admin approves a top-up.
    // Legacy 'trial' brands are accepted too for backwards compatibility
    // until they get their first top-up approved (which flips them).
    if (!brand || (brand.status !== 'active' && brand.status !== 'trial')) {
      return NextResponse.json({ enabled: false });
    }

    // Fetch widget config for this brand
    const { data: config } = await supabase
      .from('widget_configs')
      .select('enabled, button_text, button_color, button_position, show_platform_logo')
      .eq('brand_id', brandId)
      .single();

    return NextResponse.json({
      brandId,
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      buttonText: config?.button_text ?? DEFAULT_CONFIG.buttonText,
      buttonColor: config?.button_color ?? DEFAULT_CONFIG.buttonColor,
      buttonPosition: config?.button_position ?? DEFAULT_CONFIG.buttonPosition,
      showPlatformLogo: config?.show_platform_logo ?? DEFAULT_CONFIG.showPlatformLogo,
      apiEndpoint: process.env.NEXT_PUBLIC_API_URL ?? 'https://api.tryinstantfit.com',
    });
  } catch (error) {
    console.error('[config] Error fetching widget config:', error);
    // Return default config on error so the widget still works
    return NextResponse.json({
      brandId,
      ...DEFAULT_CONFIG,
      apiEndpoint: process.env.NEXT_PUBLIC_API_URL ?? 'https://api.tryinstantfit.com',
    });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const body = await request.json().catch(() => ({}));
  const { data, error } = await supabase
    .from('widget_configs')
    .update({ show_platform_logo: body.showPlatformLogo !== false, updated_at: new Date().toISOString() })
    .eq('brand_id', brandId)
    .select('brand_id, show_platform_logo')
    .single();
  if (error) return NextResponse.json({ error: 'Could not update download branding' }, { status: 400 });
  return NextResponse.json(data);
}

// Handle preflight
export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
