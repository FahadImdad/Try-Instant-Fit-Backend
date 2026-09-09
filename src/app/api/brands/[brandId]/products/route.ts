import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { uploadProductImage, uploadIsolatedGarment } from '@/lib/storage';
import { isolateGarment, TRYON_MODEL } from '@/lib/gemini';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const maxDuration = 90;

// Auto-generate a product SKU/code when the brand doesn't supply one.
// The SKU doubles as the product_id used in storage paths, QR links, and the
// garment cache, so it must be unique and URL-safe. Format: TIF-XXXXXXXX
// (timestamp + random, base36, uppercase) — readable and collision-resistant.
function generateSku(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `TIF-${(ts + rand).toUpperCase()}`;
}

function normalizeSizes(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(values.map(v => String(v).trim()).filter(Boolean))].slice(0, 30);
}

// Normalize a vendor-supplied "Buy Now" link. Returns a clean http(s) URL, or
// null when empty / unparseable. Bare domains (shop.com/x) get https:// added.
// Only http/https are allowed — blocks javascript:, data:, etc. for safety
// since this URL is rendered as a link on the customer-facing scan page.
export function normalizeBuyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

/**
 * GET /api/brands/[brandId]/products
 * List all products for a brand.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, name, price, currency, description, category, category_group, audience, available_sizes, custom_size_available, custom_size_note, show_in_catalog, buy_url, image_url, isolated_garment_url, active, created_at')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ products: data ?? [] }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('[products GET]', e);
    return NextResponse.json({ error: 'Failed to load products' }, { status: 500, headers: CORS });
  }
}

/**
 * POST /api/brands/[brandId]/products
 * Create a new product. Accepts multipart/form-data with optional image upload.
 *
 * Fields: sku, name, price, currency, description, image (file)
 * If image uploaded → isolates the garment via the AI engine and caches it for later try-ons.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;
    const ct = request.headers.get('content-type') || '';
    let body: Record<string, unknown> = {};
    let imageFile: File | null = null;

    if (ct.includes('multipart/form-data')) {
      const fd = await request.formData();
      imageFile = fd.get('image') as File | null;
      body = {
        sku: fd.get('sku'),
        name: fd.get('name'),
        price: fd.get('price') ? parseFloat(fd.get('price') as string) : null,
        currency: (fd.get('currency') as string) || 'PKR',
        description: fd.get('description'),
        category: fd.get('category'),
        category_group: fd.get('category_group'),
        audience: fd.get('audience'),
        available_sizes: fd.get('available_sizes'),
        custom_size_available: fd.get('custom_size_available') === 'true' || fd.get('custom_size_available') === '1',
        custom_size_note: fd.get('custom_size_note'),
        buy_url: fd.get('buy_url'),
        // Catalog publication is explicit. Absent means private.
        show_in_catalog: fd.has('show_in_catalog')
          ? fd.get('show_in_catalog') === 'true' || fd.get('show_in_catalog') === '1'
          : false,
      };
    } else {
      body = await request.json();
    }

    const { sku, name, price, currency, description, category, category_group, audience, available_sizes, custom_size_available, custom_size_note, show_in_catalog, buy_url } = body as {
      sku?: string; name?: string; price?: number | null; currency?: string; description?: string;
      category?: string | null; category_group?: string | null; audience?: string | null;
      available_sizes?: string[] | string; custom_size_available?: boolean; custom_size_note?: string | null;
      show_in_catalog?: boolean; buy_url?: string | null;
    };

    // Name is required; SKU/code is auto-generated when the brand doesn't
    // provide one (the dashboard no longer asks for it). A supplied SKU is
    // still honored so brands with existing codes can pass their own.
    if (!name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400, headers: CORS });
    }
    const resolvedSku = sku?.trim() || generateSku();
    if (price !== null && price !== undefined && (typeof price !== 'number' || price < 0)) {
      return NextResponse.json({ error: 'price must be a non-negative number' }, { status: 400, headers: CORS });
    }

    // Verify brand + check quota (image processing costs 1 try-on credit)
    const { data: brand } = await supabase
      .from('brands')
      .select('id, status, price_per_tryon_usd, tryon_credits, tryon_credits_used, unlimited')
      .eq('id', brandId)
      .maybeSingle();
    if (!brand) return NextResponse.json({ error: 'Brand not found' }, { status: 404, headers: CORS });

    // Gate: brands must be admin-approved (status='active') or on the
    // 'unlimited' plan before they can consume credits. Pending / suspended
    // brands can still log in and view their dashboard, but actions that
    // would deduct credits are blocked here.
    if (!brand.unlimited && brand.status !== 'active') {
      return NextResponse.json(
        { error: 'Your account is pending admin approval. Image processing will resume once your brand is approved.', code: 'NOT_APPROVED' },
        { status: 403, headers: CORS },
      );
    }

    // If we'll process an image, the brand needs at least 1 credit
    const willProcessImage = imageFile && imageFile.size > 0;
    if (willProcessImage && !brand.unlimited) {
      const remaining = (brand.tryon_credits || 0) - (brand.tryon_credits_used || 0);
      if (remaining <= 0) {
        return NextResponse.json(
          { error: 'No credits remaining. Top up to add more products.', code: 'QUOTA_EXCEEDED' },
          { status: 402, headers: CORS },
        );
      }
    }

    // Process image if uploaded
    let imageUrl: string | null = null;
    let isolatedUrl: string | null = null;

    if (imageFile && imageFile.size > 0) {
      if (!ALLOWED_TYPES.includes(imageFile.type)) {
        return NextResponse.json({ error: 'Image must be JPG, PNG, or WebP' }, { status: 400, headers: CORS });
      }
      if (imageFile.size > MAX_IMAGE_SIZE) {
        return NextResponse.json({ error: 'Image must be under 10MB' }, { status: 400, headers: CORS });
      }
      const buf = Buffer.from(await imageFile.arrayBuffer());
      imageUrl = await uploadProductImage(buf, brandId, resolvedSku, imageFile.type);

      // Pre-process garment for AI try-on (best-effort)
      try {
        const productBase64 = buf.toString('base64');
        const isolated = await isolateGarment(productBase64, imageFile.type);
        const isolatedBuf = Buffer.from(isolated.data, 'base64');
        isolatedUrl = await uploadIsolatedGarment(isolatedBuf, resolvedSku, isolated.mimeType);

        // Also write into legacy product_garments cache so old try-on flow works
        await supabase.from('product_garments').upsert({
          product_id: resolvedSku,
          brand_id: brandId,
          isolated_garment_url: isolatedUrl,
          mime_type: isolated.mimeType,
        }, { onConflict: 'product_id,brand_id' });
      } catch (err) {
        console.error('[products POST] isolation failed (non-fatal):', err);
      }
    }

    const { data: product, error } = await supabase
      .from('products')
      .insert({
        brand_id: brandId,
        sku: resolvedSku,
        name: name.trim(),
        price: price ?? null,
        currency: currency || 'PKR',
        description: description?.trim() || null,
        category: category?.trim() || null,
        category_group: category_group?.trim() || null,
        audience: audience?.trim() || null,
        available_sizes: normalizeSizes(available_sizes),
        custom_size_available: custom_size_available === true,
        custom_size_note: custom_size_available === true ? custom_size_note?.trim().slice(0, 240) || null : null,
        show_in_catalog: show_in_catalog === true,
        buy_url: normalizeBuyUrl(buy_url),
        image_url: imageUrl,
        isolated_garment_url: isolatedUrl,
      })
      .select('*')
      .single();

    if (error) {
      const pgErr = error as { code?: string; message?: string; details?: string; hint?: string };
      console.error('[products POST] insert failed:', pgErr);
      if (pgErr.code === '23505') {
        return NextResponse.json({ error: 'A product with this SKU already exists' }, { status: 409, headers: CORS });
      }
      const detail = pgErr.message || pgErr.details || pgErr.hint || 'database insert failed';
      return NextResponse.json(
        { error: `Failed to create product: ${detail}`, code: pgErr.code },
        { status: 500, headers: CORS },
      );
    }

    // Charge 1 credit for image processing (only if isolation succeeded AND insert succeeded)
    if (isolatedUrl && !brand.unlimited) {
      await supabase
        .from('brands')
        .update({
          tryon_credits_used: (brand.tryon_credits_used || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', brandId);

      // Log this as a tryons row so it's auditable in analytics
      // (source='ghost-layer' since we don't have a 'setup' source enum yet)
      await supabase.from('tryons').insert({
        brand_id: brandId,
        product_id: resolvedSku,
        product_name: `[Setup] ${name.trim()}`,
        result_image_url: isolatedUrl,
        ai_model: TRYON_MODEL,
        cost_usd: 0.045,
        source: 'ghost-layer',
        product_uuid: product?.id ?? null,
      });

      // Write credit_ledger row for deep analytics (uniform $0.125/credit)
      await supabase.from('credit_ledger').insert({
        brand_id: brandId,
        product_id: resolvedSku,
        kind: 'process',
        amount: 1,
        cost_usd: Number(brand.price_per_tryon_usd) || 0.125,
        notes: `Image processing for ${name.trim()}`,
      });
    }

    return NextResponse.json({ product }, { status: 201, headers: CORS });
  } catch (e) {
    console.error('[products POST]', e);
    // Extract message from Error instances AND from supabase PostgrestError-shaped objects
    let msg = 'Failed to create product';
    if (e instanceof Error) {
      msg = e.message;
    } else if (e && typeof e === 'object') {
      const obj = e as { message?: string; details?: string; hint?: string };
      msg = obj.message || obj.details || obj.hint || msg;
    }
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
