import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { avatarUrlResolver } from '../packages/server/src/auth/avatar.js';
import {
  createAuthProvider,
  isLoopbackBindHost,
  isPrivateBindHost,
} from '../packages/server/src/auth/factory.js';
import { createNoneProvider } from '../packages/server/src/auth/none.js';
import { createTrustedHeaderProvider } from '../packages/server/src/auth/trusted-header.js';
import { GENERIC_FORBIDDEN_HTML } from '../packages/server/src/pages/forbidden-page.js';

function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    serverPort: 1,
    serverHost: '127.0.0.1',
    dataDir: './temp',
    logLevel: 'error',
    ...overrides,
  };
}

describe('createAuthProvider (auto detection)', () => {
  it('AUTH_HEADER selects trusted-header (loopback needs no proxy flag)', () => {
    const p = createAuthProvider(baseConfig({ authHeaderName: 'X-Auth-Request-User' }));
    assert.equal(p.kind, 'trusted-header');
  });

  it('loopback bind without config gets none', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      assert.equal(createAuthProvider(baseConfig({ serverHost: host })).kind, 'none', host);
    }
  });

  it('private bind with AUTH_INSECURE_ALLOW gets none', () => {
    assert.equal(
      createAuthProvider(baseConfig({ serverHost: '10.0.0.5', authInsecureAllow: true })).kind,
      'none',
    );
  });

  it('trusted-header guard applies on the auto path too', () => {
    assert.throws(
      () => createAuthProvider(baseConfig({ authHeaderName: 'X-User', serverHost: '0.0.0.0' })),
      /AUTH_TRUSTED_PROXY/,
    );
    assert.equal(
      createAuthProvider(baseConfig({ authHeaderName: 'X-User', serverHost: '0.0.0.0', authTrustedProxy: true })).kind,
      'trusted-header',
    );
  });
});

describe('createAuthProvider (explicit AUTH_PROVIDER)', () => {
  it('trusted-header requires AUTH_HEADER', () => {
    assert.throws(
      () => createAuthProvider(baseConfig({ authProviderName: 'trusted-header' })),
      /AUTH_HEADER/,
    );
    assert.equal(
      createAuthProvider(baseConfig({ authProviderName: 'trusted-header', authHeaderName: 'X-User' })).kind,
      'trusted-header',
    );
  });

  it('trusted-header on non-loopback requires AUTH_TRUSTED_PROXY', () => {
    assert.throws(
      () =>
        createAuthProvider(
          baseConfig({ authProviderName: 'trusted-header', authHeaderName: 'X-User', serverHost: '0.0.0.0' }),
        ),
      /AUTH_TRUSTED_PROXY/,
    );
    assert.equal(
      createAuthProvider(
        baseConfig({ authProviderName: 'trusted-header', authHeaderName: 'X-User', serverHost: '0.0.0.0', authTrustedProxy: true }),
      ).kind,
      'trusted-header',
    );
  });

  it('none explicit: loopback ok; private needs ALLOW; public never', () => {
    assert.equal(createAuthProvider(baseConfig({ authProviderName: 'none' })).kind, 'none');
    assert.equal(
      createAuthProvider(
        baseConfig({ authProviderName: 'none', serverHost: '192.168.1.10', authInsecureAllow: true }),
      ).kind,
      'none',
    );
    assert.throws(
      () => createAuthProvider(baseConfig({ authProviderName: 'none', serverHost: '192.168.1.10' })),
      /AUTH_INSECURE_ALLOW/,
    );
    // Binding all interfaces includes the public net; ALLOW still does not permit it
    assert.throws(
      () =>
        createAuthProvider(
          baseConfig({ authProviderName: 'none', serverHost: '0.0.0.0', authInsecureAllow: true }),
        ),
      /none/i,
    );
  });

  it('unknown provider name fails loudly instead of falling back', () => {
    assert.throws(() => createAuthProvider(baseConfig({ authProviderName: 'oauth' })), /Unknown AUTH_PROVIDER/);
  });
});

// After Task 2 landed: this set pins "route to password, and never silently become none / run naked".
describe('password wiring', () => {
  it('AUTH_PASSWORD on loopback routes to the password provider (not none)', () => {
    assert.equal(
      createAuthProvider(baseConfig({ authPassword: 'x'.repeat(8) })).kind,
      'password',
    );
  });

  it('no config on a non-loopback bind routes to the password provider', () => {
    assert.equal(createAuthProvider(baseConfig({ serverHost: '0.0.0.0' })).kind, 'password');
    assert.equal(createAuthProvider(baseConfig({ serverHost: '192.168.1.10' })).kind, 'password');
    assert.equal(createAuthProvider(baseConfig({ serverHost: '8.8.8.8' })).kind, 'password');
  });

  it('0.0.0.0 with AUTH_INSECURE_ALLOW still never gets none', () => {
    assert.equal(
      createAuthProvider(baseConfig({ serverHost: '0.0.0.0', authInsecureAllow: true })).kind,
      'password',
    );
  });

  it('explicit AUTH_PROVIDER=password works without any extras', () => {
    assert.equal(createAuthProvider(baseConfig({ authProviderName: 'password' })).kind, 'password');
  });
});

describe('trusted-header provider', () => {
  const provider = createTrustedHeaderProvider('X-Auth-Request-User');

  it('verifies the header value as the userId', async () => {
    assert.equal((await provider.verify({ 'x-auth-request-user': 'alice' }))?.userId, 'alice');
  });

  it('rejects missing, blank, and oversized values', async () => {
    assert.equal(await provider.verify({}), null);
    assert.equal(await provider.verify({ 'x-auth-request-user': '   ' }), null);
    assert.equal(await provider.verify({ 'x-auth-request-user': 'a'.repeat(200) }), null);
  });

  it('takes the first value of a repeated header', async () => {
    assert.equal((await provider.verify({ 'x-auth-request-user': ['alice', 'bob'] }))?.userId, 'alice');
  });

  it('uses the generic forbidden page and never echoes header content', () => {
    assert.equal(provider.forbiddenHtml, GENERIC_FORBIDDEN_HTML);
  });

  it('requires a header name', () => {
    assert.throws(() => createTrustedHeaderProvider('  '), /AUTH_HEADER/);
  });
});

describe('none provider', () => {
  const provider = createNoneProvider();

  it('always verifies as the single local owner', async () => {
    assert.equal((await provider.verify({}))?.userId, 'owner');
    assert.equal((await provider.verify({ cookie: 'whatever' }))?.userId, 'owner');
  });

  it('checks the handshake Origin so a hostile page cannot CSWSH the loopback server', () => {
    const local = createNoneProvider();
    // No Origin (CLI / non-browser) is allowed
    assert.equal(local.checkHandshake?.({}), null);
    assert.equal(local.checkHandshake?.({ origin: 'http://127.0.0.1:18765', host: '127.0.0.1:18765' }), null);
    // Forged Origin → reject (hostile page connecting ws://127.0.0.1 under "local mode")
    assert.match(
      local.checkHandshake?.({ origin: 'https://evil.example', host: '127.0.0.1:18765' }) ?? '',
      /Origin/,
    );
    // When PUBLIC_ORIGIN is set explicitly, compare against it
    const pinned = createNoneProvider({ publicOrigin: 'https://lifeline.example.com' });
    assert.equal(
      pinned.checkHandshake?.({ origin: 'https://lifeline.example.com', host: '127.0.0.1:18765' }),
      null,
    );
    assert.match(
      pinned.checkHandshake?.({ origin: 'https://evil.example', host: '127.0.0.1:18765' }) ?? '',
      /Origin/,
    );
  });
});

// Avatar URL is issued by the server (user:info.avatar): the provider decides, the client only falls back.
describe('avatar url', () => {
  it('is empty by default so the client falls back to initials', () => {
    assert.equal(avatarUrlResolver(undefined)('alice'), '');
    assert.equal(avatarUrlResolver('   ')('alice'), '');
    assert.equal(createNoneProvider().avatarUrlFor('owner'), '');
    assert.equal(createTrustedHeaderProvider('X-User').avatarUrlFor('alice'), '');
  });

  it('resolves the AUTH_AVATAR_URL template for every provider', async () => {
    const avatarUrlFor = avatarUrlResolver('https://cdn.example.com/avatars/{userId}.png');
    assert.equal(avatarUrlFor('alice'), 'https://cdn.example.com/avatars/alice.png');
    // Wired into the provider: trusted-header via the factory's automatic path behaves the same
    const provider = createAuthProvider(
      baseConfig({
        authHeaderName: 'X-User',
        authAvatarUrl: 'https://cdn.example.com/avatars/{userId}.png',
      }),
    );
    assert.equal((await provider.verify({ 'x-user': 'bob' }))?.userId, 'bob');
    assert.equal(provider.avatarUrlFor('bob'), 'https://cdn.example.com/avatars/bob.png');
  });

  it('requires the {userId} placeholder instead of silently serving one image to everyone', () => {
    assert.throws(() => avatarUrlResolver('https://cdn.example.com/all.png'), /\{userId\}/);
    assert.throws(
      () => createAuthProvider(baseConfig({ authAvatarUrl: 'https://cdn.example.com/all.png' })),
      /AUTH_AVATAR_URL/,
    );
  });

  it('URL-encodes the user id and refuses an empty one', () => {
    const avatarUrlFor = avatarUrlResolver('https://cdn.example.com/{userId}.png');
    assert.equal(avatarUrlFor('a/b?c'), 'https://cdn.example.com/a%2Fb%3Fc.png');
    assert.equal(avatarUrlFor('  '), '');
  });
});

describe('generic forbidden page', () => {
  it('stays self-contained and branded', () => {
    assert.match(GENERIC_FORBIDDEN_HTML, /LIFE/);
    assert.match(GENERIC_FORBIDDEN_HTML, /Sign-in required/);
    assert.doesNotMatch(GENERIC_FORBIDDEN_HTML, /src=|href="http/);
  });
});

describe('bind host classification', () => {
  it('loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '  127.0.0.1  ']) {
      assert.ok(isLoopbackBindHost(h), h);
    }
    assert.ok(!isLoopbackBindHost('0.0.0.0'));
    assert.ok(!isLoopbackBindHost('127.0.0.2'));
    assert.ok(!isLoopbackBindHost('::'));
  });

  it('private = RFC1918 + Tailscale CGNAT + IPv6 ULA; all-interfaces and public are not', () => {
    for (const h of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '100.64.0.7',
      '100.127.255.255',
      'fc00::1',
      'fd00::abcd',
      'FD12::1',
      '[fd00::1]',
      '127.0.0.1',
    ]) {
      assert.ok(isPrivateBindHost(h), h);
    }
    for (const h of [
      '8.8.8.8',
      '0.0.0.0',
      '::',
      '1.2.3.4',
      '100.128.0.1', // outside CGNAT
      '172.32.0.1', // outside 172.16/12
      'fe80::1', // link-local is not ULA
      '2001:db8::1',
    ]) {
      assert.ok(!isPrivateBindHost(h), h);
    }
  });
});
