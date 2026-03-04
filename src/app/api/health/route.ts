import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'tryinstantfit-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
}
