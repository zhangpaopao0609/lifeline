import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { isLoopbackBindHost, isPrivateBindHost } from './bind-host.js';
import { headerString } from './origin.js';

/** Strip IPv4-mapped IPv6 (`::ffff:1.2.3.4`) so the private/loopback checks see the v4 address. */
export function normalizePeer(peer: string): string {
  const trimmed = peer.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

/**
 * Rate-limit bucket key.
 * A public peer always uses its own address (forwarded headers are ignored).
 * A loopback or private peer (nginx on the host, or the docker bridge) uses `X-Real-IP`
 * only when the operator set AUTH_TRUSTED_PROXY=1, and only when that header is a single IP.
 */
/** Tailscale CGNAT is a client network. It must not be treated as the reverse proxy in front of the server. */
function isCgnat(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4)
    return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

export function rateLimitKey(peer: string, headers: IncomingHttpHeaders, trustedProxy: boolean): string {
  const addr = normalizePeer(peer);
  const proxyReachable = (isLoopbackBindHost(addr) || isPrivateBindHost(addr)) && !isCgnat(addr);
  if (trustedProxy && proxyReachable) {
    const raw = headerString(headers, 'x-real-ip')?.trim() ?? '';
    if (raw && !raw.includes(',')) {
      const real = normalizePeer(raw);
      if (isIP(real))
        return real;
    }
  }
  return addr || 'unknown';
}
