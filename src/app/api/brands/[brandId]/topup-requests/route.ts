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
 *
 * The brand creates a pending top-up request that admin will review.
 *
 * Two flows are supported:
 *
 * 1. WHATSAPP RECEIPT FLOW (preferred, current dashboard behaviour):
 *    Brand picks credit count -> dashboard generates a receipt and opens
 *    wa.me with a pre-filled message. Right before opening WhatsApp it
 *    POSTs JSON here so the request shows up as "pending" in admin.
 *    No screenshot, no payment_method needed — payment + screenshot are
 *    handled out-of-band on WhatsApp.
 *    Accepts both application/json and multipart/form-data.
 *
 * 2. LEGACY SCREENSHOT FLOW (older dashboard/admin):
 *    Brand pays, uploads the screenshot in-page, picks payment_method.
 *    multipart/form-data with `screenshot` and `payment_method` fields.
 *
 * Required fields (both flows):
 *   amount_usd          number, > 0
 *   credits_requested   integer, > 0
 *
 * Optional fields:
 *   amount_local, local_currency, payment_method (defaults to 'whatsapp'
 *   when no screenshot is uploaded), payment_ref, notes, receipt_id,
 *   screenshot (file).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const ct = request.headers.get('content-type') || '';

    let amountUsd: number;
    let amountLocal: number | null = null;
    let localCurrency: string | null = null;
    let creditsRequested: number;
    let paymentMethod: string | null = null;
    let paymentRef: string | null = null;
    let notes: string | null = null;
    let receiptId: string | null = null;
    let screenshot: File | null = null;

    if (ct.includes('application/json')) {
      const body = await request.json();
      amountUsd        = parseFloat(String(body.amount_usd));
      amountLocal      = body.amount_local != null ? parseFloat(String(body.amount_local)) : null;
      localCurrency    = body.local_currency ?? null;
      creditsRequested = parseInt(String(body.credits_requested), 10);
      paymentMethod    = body.payment_method ?? null;
      paymentRef       = body.payment_ref ?? null;
      notes            = body.notes ?? null;
      receiptId        = body.receipt_id ?? null;
    } else if (ct.includes('multipart/form-data')) {
      const fd = await request.formData();
      amountUsd        = parseFloat(fd.get('amount_usd') as string);
      amountLocal      = fd.get('amount_local') ? parseFloat(fd.get('amount_local') as string) : null;
      localCurrency    = (fd.get('local_currency') as string) || null;
      creditsRequested = parseInt(fd.get('credits_requested') as string, 10);
      paymentMethod    = (fd.get('payment_method') as string) || null;
      paymentRef       = (fd.get('payment_ref') as string) || null;
      notes            = (fd.get('notes') as string) || null;
      receiptId        = (fd.get('receipt_id') as string) || null;
      screenshot       = fd.get('screenshot') as File | null;
    } else {
      return NextResponse.json({ error: 'Content-Type must be application/json or multipart/form-data' }, { status: 400, headers: CORS });
    }

    if (isNaN(amountUsd) || amountUsd <= 0) {
      return NextResponse.json({ error: 'Valid amount_usd required' }, { status: 400, headers: CORS });
    }
    if (isNaN(creditsRequested) || creditsRequested <= 0) {
      return NextResponse.json({ error: 'Valid credits_requested required' }, { status: 400, headers: CORS });
    }

    // Verify brand
    const { data: brand } = await supabase.from('brands').select('id').eq('id', brandId).maybeSingle();
    if (!brand) return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS });

    // Upload screenshot (legacy flow only)
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
    }

    // Default payment method when none provided (WhatsApp receipt flow)
    const finalPaymentMethod = paymentMethod?.trim() || 'whatsapp';

    // Pack receipt_id into notes when present so admins can match the
    // dashboard receipt to the pending request without a schema change.
    const finalNotes = receiptId
      ? `Receipt: ${receiptId}${notes ? ' — ' + notes : ''}`
      : (notes?.trim() || null);

    const { data, error } = await supabase
      .from('credit_topup_requests')
      .insert({
        brand_id: brandId,
        amount_usd: amountUsd,
        amount_local: amountLocal,
        local_currency: localCurrency,
        credits_requested: creditsRequested,
        payment_screenshot_url: screenshotUrl,
        payment_method: finalPaymentMethod,
        payment_ref: paymentRef?.trim() || null,
        notes: finalNotes,
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
