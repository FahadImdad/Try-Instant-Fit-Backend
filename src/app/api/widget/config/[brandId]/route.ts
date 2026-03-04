import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const DEFAULT_CONFIG = {
  enabled: true,
  buttonText: 'Try It On ✨',
  buttonColor: '#1a1a2e',
  buttonPosition: 'bottom-right' as const,
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

    if (!brand || (brand.status !== 'active' && brand.status !== 'trial')) {
      return NextResponse.json({ enabled: false });
    }

    // Fetch widget config for this brand
    const { data: config } = await supabase
      .from('widget_configs')
      .select('enabled, button_text, button_color, button_position')
      .eq('brand_id', brandId)
      .single();

    return NextResponse.json({
      brandId,
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      buttonText: config?.button_text ?? DEFAULT_CONFIG.buttonText,
      buttonColor: config?.button_color ?? DEFAULT_CONFIG.buttonColor,
      buttonPosition: config?.button_position ?? DEFAULT_CONFIG.buttonPosition,
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

// Handle preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
