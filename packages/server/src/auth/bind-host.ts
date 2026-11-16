const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase());
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4)
    return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part))
      return null;
    const n = Number(part);
    if (n > 255)
      return null;
    octets.push(n);
  }
  return octets;
}

/** IPv6 ULA (fc00::/7, i.e. fc** / fd** prefix). link-local (fe80::/10) does not count. */
function isIpv6Ula(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!bare.includes(':'))
    return false;
  const first = bare.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(first))
    return false; // '::' → first group empty → all-interfaces, not ULA
  return (Number.parseInt(first, 16) & 0xFE00) === 0xFC00;
}

/**
 * Bind addresses "not worth trusting by default, but may run bare with explicit AUTH_INSECURE_ALLOW=1":
 * loopback, RFC1918 private, Tailscale CGNAT (100.64/10), IPv6 ULA (fc00::/7).
 * `0.0.0.0` / `::` are all-interface binds (including the public internet) and never count as private;
 * IPv6 other than loopback / ULA is treated as public (conservative). Note Docker `-p` can map
 * container-internal loopback onto the public internet — this layer cannot catch that (auth matrix is
 * in the repo-root .env.example).
 */
export function isPrivateBindHost(host: string): boolean {
  if (isLoopbackBindHost(host))
    return true;
  const bare = host.trim().replace(/^\[|\]$/g, '');
  if (bare === '::')
    return false;
  if (isIpv6Ula(bare))
    return true;
  const octets = ipv4Octets(bare);
  if (!octets)
    return false;
  const [a, b] = octets;
  if (a === 10)
    return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31)
    return true; // 172.16/12
  if (a === 192 && b === 168)
    return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127)
    return true; // CGNAT 100.64/10 (Tailscale)
  return false;
}
