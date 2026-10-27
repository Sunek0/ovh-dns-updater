import { timingSafeEqual } from 'node:crypto';

/**
 * Extracts the token from a strict RFC 6750 `Authorization: Bearer <token>`
 * header. Returns undefined for any other scheme or malformed value.
 */
export function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  if (parts[0].toLowerCase() !== 'bearer') return undefined;

  return parts[1] || undefined;
}

/** Constant-time comparison for non-empty secrets. */
export function safeEqual(left?: string, right?: string): boolean {
  if (!left || !right) return false;

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

/** True when the request header carries the master API key as a Bearer token. */
export function isMasterBearer(header: string | undefined, apiKey: string): boolean {
  return safeEqual(extractBearerToken(header), apiKey);
}
