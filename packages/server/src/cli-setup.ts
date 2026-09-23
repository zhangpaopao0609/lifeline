import { randomBytes } from 'node:crypto';

const CODE_TTL_MS = 120_000;

export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  }
  catch {
    return false;
  }
  if (url.protocol !== 'http:')
    return false;
  if (url.hostname !== '127.0.0.1')
    return false;
  if (url.pathname !== '/callback')
    return false;
  if (url.username || url.password)
    return false;
  if (url.hash)
    return false;
  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return false;
  return true;
}

/**
 * One-shot setup code. **The code is bound to the logged-in identity at issue time** (`/cli-setup`
 * itself requires auth): exchange redeems the owner, then a per-machine token is issued for agentId.
 */
export class CliSetupCodes {
  private codes = new Map<string, { owner: string; createdAt: number }>();

  constructor(
    private readonly ttlMs: number = CODE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(owner = ''): string {
    const code = randomBytes(32).toString('hex');
    this.codes.set(code, { owner, createdAt: this.now() });
    return code;
  }

  /**
   * Returns the issuing userId once ('' = issuer with no identity); null for unknown, expired
   * or already-used codes. Used codes are deleted.
   */
  exchange(code: string): string | null {
    if (typeof code !== 'string' || code.length === 0)
      return null;
    const entry = this.codes.get(code);
    if (entry === undefined)
      return null;
    this.codes.delete(code);
    if (this.now() - entry.createdAt > this.ttlMs)
      return null;
    return entry.owner;
  }
}
