import type { IncomingHttpHeaders } from 'node:http';

/**
 * Derive the browser Origin "expected origin", shared by password and none handshake checks.
 * Expected-value chain (spec frozen): PUBLIC_ORIGIN > X-Forwarded-Host(+Proto) > raw Host.
 * Never compare against raw Host alone — nginx reverse-proxying to 127.0.0.1:3000 without rewriting
 * Host would kill every legitimate WS (review B-S4).
 */

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function headerString(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  if (typeof raw === 'string')
    return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return raw[0];
  return null;
}

/**
 * When an Origin header is present it must match the expected origin (cross-site WS handshakes carry
 * the victim's cookie, unprotected by same-origin policy); no Origin (CLI and other non-browser
 * clients) is allowed. Return null = pass.
 */
export function checkOriginAgainstExpected(
  headers: IncomingHttpHeaders,
  publicOrigin?: string,
): string | null {
  const origin = headerString(headers, 'origin');
  if (!origin)
    return null;
  const expected = expectedOrigin(headers, publicOrigin);
  if (!expected)
    return null;
  if (normalizeOrigin(origin) !== expected) {
    return 'Origin mismatch: set PUBLIC_ORIGIN to the address browsers use';
  }
  return null;
}

export function expectedOrigin(headers: IncomingHttpHeaders, publicOrigin?: string): string | null {
  if (publicOrigin)
    return normalizeOrigin(publicOrigin);
  const forwardedHost = headerString(headers, 'x-forwarded-host');
  if (forwardedHost) {
    const proto = headerString(headers, 'x-forwarded-proto') === 'http' ? 'http' : 'https';
    return normalizeOrigin(`${proto}://${forwardedHost}`);
  }
  const host = headerString(headers, 'host');
  if (!host)
    return null;
  const proto = headerString(headers, 'x-forwarded-proto') === 'https' ? 'https' : 'http';
  return normalizeOrigin(`${proto}://${host}`);
}
