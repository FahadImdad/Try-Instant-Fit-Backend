import { NextResponse } from 'next/server';

// Minimal root — redirect to API docs or health check
export default function Page() {
  return (
    <div style={{ fontFamily: 'monospace', padding: '40px' }}>
      <h1>Try Instant Fit — Backend API</h1>
      <p>Available endpoints:</p>
      <ul>
        <li>GET /api/widget/config/:brandId</li>
        <li>POST /api/widget/try-on</li>
        <li>POST /api/widget/track</li>
        <li>GET /api/health</li>
      </ul>
    </div>
  );
}
