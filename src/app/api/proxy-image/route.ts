import { NextRequest, NextResponse } from 'next/server';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * GET /api/proxy-image?url=<encoded-gcs-url>
 *
 * Same-origin proxy for try-on result images stored on Google Cloud Storage.
 * The website domain (tryinstantfit.com) can't fetch storage.googleapis.com
 * directly because the bucket isn't CORS-configured for that origin — which
 * means client-side canvas operations (watermarking, blob downloads, file
 * sharing via Web Share API) all fail.
 *
 * This endpoint fetches the image server-side and re-emits it from our own
 * domain so the browser sees a same-origin response. Locked to our bucket
 * to prevent abuse as an open SSRF/relay.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'url query param required' }, { status: 400, headers: CORS });
  }

  // Only allow URLs from our own GCS bucket — prevents this endpoint from
  // being used as a generic SSRF/anonymising proxy for arbitrary URLs.
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  const allowedPrefixes = [
    bucketName ? `https://storage.googleapis.com/${bucketName}/` : null,
    'https://storage.googleapis.com/tryinstantfit-',
  ].filter(Boolean) as string[];

  if (!allowedPrefixes.some(p => url.startsWith(p))) {
    return NextResponse.json({ error: 'URL not allowed' }, { status: 403, headers: CORS });
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return NextResponse.json({ error: 'Upstream fetch failed' }, { status: upstream.status, headers: CORS });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';

    return new NextResponse(buf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': contentType,
        // Browser caches the proxied bytes for an hour — safe because the GCS
        // URL itself is content-addressed (timestamp + random suffix in the
        // path), so the same URL always returns the same image.
        'Cache-Control': 'public, max-age=3600, immutable',
      },
    });
  } catch (err) {
    console.error('[proxy-image]', err);
    return NextResponse.json({ error: 'Proxy failed' }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
