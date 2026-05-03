import { randomBytes } from 'crypto';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const QR_CORS = CORS_HEADERS;

/** Generate a URL-safe scan token (10 chars, ~60 bits of entropy). */
export function generateToken(): string {
  return randomBytes(8).toString('base64url').slice(0, 10);
}

/** Generate a short, friendly passcode like "X4K9P7M2" (8 chars, uppercase + digits). */
export function generatePasscode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const bytes = randomBytes(8);
  return Array.from(bytes).map(b => alphabet[b % alphabet.length]).join('');
}
