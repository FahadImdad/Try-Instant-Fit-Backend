import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { uploadPaymentScreenshot } from '@/lib/storage';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/topup-requests
 * Brand sees their topup history (newest first).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const { data, error } = await supabase
      .from('credit_topup_requests')
      .select('*')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ topups: data ?? [] }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[topup GET]', e);
    return NextResponse.json({ error: 'Failed to load topups' }, { status: 500, headers: CORS });
  }
}

/**
 * POST /api/brands/[brandId]/topup-requests
 * Brand submits a top-up request with payment screenshot.
 *
 * Multipart fields:
 *   amount_usd (required, what they're paying in USD-equivalent)
 *   amount_local (optional, what they paid in local currency e.g. PKR)
 *   local_currency (optional, e.g. 'PKR')
 *   credits_requested (required, computed from amount_usd / brand.price_per_tryon_usd)
 *   payment_method (required: bank_transfer | jazzcash | easypaisa | card)
 *   payment_ref (optional, transaction id)
 *   notes (optional)
 *   screenshot (file, required)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'multipart/form-data required' }, { status: 400, headers: CORS });
    }
    const fd = await request.formData();

    const amountUsd = parseFloat(fd.get('amount_usd') as string);
    const amountLocal = fd.get('amount_local') ? parseFloat(fd.get('amount_local') as string) : null;
    const localCurrency = (fd.get('local_currency') as string) || null;
    const creditsRequested = parseInt(fd.get('credits_requested') as string, 10);
    const paymentMethod = fd.get('payment_method') as string;
    const paymentRef = fd.get('payment_ref') as string;
    const notes = fd.get('notes') as string;
    const screenshot = fd.get('screenshot') as File | null;

    if (isNaN(amountUsd) || amountUsd <= 0) {
      return NextResponse.json({ error: 'Valid amount_usd required' }, { status: 400, headers: CORS });
    }
    if (isNaN(creditsRequested) || creditsRequested <= 0) {
      return NextResponse.json({ error: 'Valid credits_requested required' }, { status: 400, headers: CORS });
    }
    if (!paymentMethod) {
      return NextResponse.json({ error: 'payment_method is required' }, { status: 400, headers: CORS });
    }

    // Verify brand
    const { data: brand } = await supabase.from('brands').select('id').eq('id', brandId).maybeSingle();
    if (!brand) return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS });

    // Upload screenshot
    let screenshotUrl: string | null = null;
    if (screenshot && screenshot.size > 0) {
      if (!ALLOWED_TYPES.includes(screenshot.type)) {
        return NextResponse.json({ error: 'Screenshot must be JPG, PNG, or WebP' }, { status: 400, headers: CORS });
      }
      if (screenshot.size > MAX_SCREENSHOT_SIZE) {
        return NextResponse.json({ error: 'Screenshot must be under 10MB' }, { status: 400, headers: CORS });
      }
      const buf = Buffer.from(await screenshot.arrayBuffer());
      screenshotUrl = await uploadPaymentScreenshot(buf, brandId, screenshot.type);
    } else {
      return NextResponse.json({ error: 'Payment screenshot is required' }, { status: 400, headers: CORS });
    }

    const { data, error } = await supabase
      .from('credit_topup_requests')
      .insert({
        brand_id: brandId,
        amount_usd: amountUsd,
        amount_local: amountLocal,
        local_currency: localCurrency,
        credits_requested: creditsRequested,
        payment_screenshot_url: screenshotUrl,
        payment_method: paymentMethod,
        payment_ref: paymentRef?.trim() || null,
        notes: notes?.trim() || null,
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) throw error;

    return NextResponse.json({ topup: data }, { status: 201, headers: CORS });
  } catch (e) {
    console.error('[topup POST]', e);
    const msg = e instanceof Error ? e.message : 'Failed to submit top-up request';
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
