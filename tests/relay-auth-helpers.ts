/**
 * Test "identity" and the enroll flow (the server half).
 *
 * Auth has no built-in SSO: this uses the trusted-header provider (AUTH_HEADER) — a username in
 * the request header is identity, the same path a real deploy's gateway / reverse proxy uses to
 * inject the user header. Machine-token ownership is recorded under that username (the identity
 * at `/cli-setup` issue time).
 */
export const TEST_AUTH_HEADER = 'x-test-user';

/** loopback + AUTH_HEADER = trusted-header (AUTH_TRUSTED_PROXY is not required). */
export const TEST_AUTH_CONFIG = { authHeaderName: TEST_AUTH_HEADER } as const;

/** Callers that did not name a user (agent enroll probes, default browser) use this identity. */
export const TEST_OWNER = 'test-owner';

/** Identity headers for a given user. */
export function userHeaders(userId: string): Record<string, string> {
  return { [TEST_AUTH_HEADER]: userId };
}

/**
 * Open `/cli-setup` with identity to get a one-time code, then exchange `{ code, agentId }` for
 * **this machine's** token — the same path as CLI `lifeline setup`. The plaintext is returned only this once.
 */
export async function enrollAgentToken(
  base: string,
  userId: string = TEST_OWNER,
  agentId: string,
): Promise<string> {
  const redirect = 'http://127.0.0.1:9/callback';
  const setup = await fetch(`${base}/cli-setup?redirect_uri=${encodeURIComponent(redirect)}`, {
    headers: userHeaders(userId),
    redirect: 'manual',
  });
  if (setup.status !== 302)
    throw new Error(`/cli-setup returned ${setup.status}`);
  const code = new URL(setup.headers.get('location') ?? '').searchParams.get('code');
  if (!code)
    throw new Error('/cli-setup did not hand out a code');

  const exchange = await fetch(`${base}/public/cli-setup/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, agentId }),
  });
  const body = (await exchange.json()) as { agentToken?: string };
  if (!body.agentToken)
    throw new Error('exchange did not return an agent token');
  return body.agentToken;
}
