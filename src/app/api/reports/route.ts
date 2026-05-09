import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_TYPES   = ['tryon_bad', 'image_bad', 'feedback', 'difficulty'] as const;
const VALID_SOURCES = ['customer', 'brand'] as const;

type ReportType   = typeof VALID_TYPES[number];
type ReportSource = typeof VALID_SOURCES[number];

/**
 * POST /api/reports
 *
 * Customer + brand-side reports of bad try-ons, bad image-processing,
 * general feedback, and platform difficulties. An admin reviews the
 * 'tryon_bad' / 'image_bad' reports and can approve a credit refund
 * via the admin endpoint (separate route).
 *
 * Body (application/json):
 *   {
 *     type:           'tryon_bad' | 'image_bad' | 'feedback' | 'difficulty',
 *     source?:        'customer' | 'brand',          // default 'customer'
 *     rating?:        number,                         // -1..5
 *     reason?:        string,                         // short reason / category
 *     message?:       string,                         // free-text note
 *     screenshot_url?: string,                        // user-uploaded asset
 *     result_url?:    string,                         // try-on image being reported
 *     brand_id?:      UUID,
 *     tryon_id?:      UUID,
 *     product_id?:    UUID,
 *     qr_id?:         UUID,
 *   }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      type,
      source,
      rating,
      reason,
      message,
      screenshot_url,
      result_url,
      brand_id,
      tryon_id,
      product_id,
      qr_id,
    } = body as {
      type?: string;
      source?: string;
      rating?: number;
      reason?: string;
      message?: string;
      screenshot_url?: string;
      result_url?: string;
      brand_id?: string;
      tryon_id?: string;
      product_id?: string;
      qr_id?: string;
    };

    if (!type || !VALID_TYPES.includes(type as ReportType)) {
      return NextResponse.json(
        { error: `type must be one of: ${VALID_TYPES.join(', ')}` },
        { status: 400, headers: CORS },
      );
    }

    const resolvedSource: ReportSource = VALID_SOURCES.includes(source as ReportSource)
      ? (source as ReportSource)
      : 'customer';

    if (rating !== undefined && (typeof rating !== 'number' || rating < -1 || rating > 5)) {
      return NextResponse.json(
        { error: 'rating must be a number between -1 and 5' },
        { status: 400, headers: CORS },
      );
    }

    // Refund-eligible reports must include image proof (the result image
    // and/or a user screenshot). Without proof we won't process them, so
    // the admin queue stays free of un-actionable reports.
    const isRefundEligible = type === 'tryon_bad' || type === 'image_bad';
    if (isRefundEligible && !result_url?.trim() && !screenshot_url?.trim()) {
      return NextResponse.json(
        { error: 'A picture or screenshot is required to report a bad try-on or bad image processing. Reports without proof cannot be processed for a refund.' },
        { status: 400, headers: CORS },
      );
    }

    if (!message?.trim() && !reason?.trim() && rating === undefined && !screenshot_url && !result_url) {
      return NextResponse.json(
        { error: 'Provide at least one of: message, reason, rating, screenshot_url, result_url' },
        { status: 400, headers: CORS },
      );
    }

    const { data, error } = await supabase
      .from('tryon_reports')
      .insert({
        type,
        source: resolvedSource,
        rating: rating ?? null,
        reason: reason?.trim() || null,
        message: message?.trim() || null,
        screenshot_url: screenshot_url?.trim() || null,
        result_url: result_url?.trim() || null,
        brand_id: brand_id || null,
        tryon_id: tryon_id || null,
        product_id: product_id || null,
        qr_id: qr_id || null,
        status: 'pending',
      })
      .select('id, created_at, status')
      .single();

    if (error) throw error;

    return NextResponse.json(
      { ok: true, report_id: data.id, status: data.status, created_at: data.created_at },
      { status: 201, headers: CORS },
    );
  } catch (err) {
    console.error('[reports] Error:', err);
    return NextResponse.json(
      { error: 'Failed to submit. Please try again.' },
      { status: 500, headers: CORS },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
