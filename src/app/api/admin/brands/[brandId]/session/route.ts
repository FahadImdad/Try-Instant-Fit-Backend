import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, ADMIN_CORS } from '@/lib/admin-auth';
import { issueBrandToken } from '@/lib/brand-auth';

/**
 * POST /api/admin/brands/[brandId]/session
 *
 * Mints a short-lived brand token so the admin console can open any vendor's
 * dashboard, as it always has. Admin Basic Auth is required to get one.
 *
 * The admin credentials themselves would also satisfy requireBrandAuth, but
 * handing the dashboard a scoped, one-hour token means admin's password never
 * has to live in the dashboard page.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  const unauthorized = requireAdminAuth(request); if (unauthorized) return unauthorized;
  const { brandId } = await params;
  return NextResponse.json({ token: issueBrandToken(brandId, 'admin') }, { headers: ADMIN_CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: ADMIN_CORS });
}
