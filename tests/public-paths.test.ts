import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLI_LATEST_FILE, PUBLIC_PREFIX } from '../packages/cli/src/version.js';
import { isPublicPath } from '../packages/server/src/public-paths.js';
import { RUNTIME_TARGETS, runtimePackageName } from '../scripts/pack-runtime.js';

describe('isPublicPath', () => {
  it('opens exactly three namespaces: /public, /healthz, /agent-io', () => {
    // Unauthenticated distribution: content (no credentials) and cli-setup/exchange (one-shot code)
    assert.equal(isPublicPath('/public/install.sh'), true);
    assert.equal(isPublicPath('/public/uninstall.sh'), true);
    assert.equal(isPublicPath('/public/lifeline.mjs'), true);
    assert.equal(isPublicPath('/public/cli-latest.txt'), true);
    assert.equal(isPublicPath('/public/cli-setup/exchange'), true);
    assert.equal(isPublicPath('/public/install.sh?x=1'), true);
    // Health probe and agent channel
    assert.equal(isPublicPath('/healthz'), true);
    assert.equal(isPublicPath('/healthz?x=1'), true);
    assert.equal(isPublicPath('/agent-io'), true);
    assert.equal(isPublicPath('/agent-io/'), true);
    assert.equal(isPublicPath('/agent-io/?EIO=4&transport=websocket'), true);
  });

  it('keeps everything else behind the identity gate', () => {
    assert.equal(isPublicPath('/'), false);
    assert.equal(isPublicPath('/index.html'), false);
    assert.equal(isPublicPath('/app.js'), false);
    assert.equal(isPublicPath('/cli-setup'), false);
    assert.equal(isPublicPath('/api/health'), false);
    assert.equal(isPublicPath('/api/debug/state'), false);
    assert.equal(isPublicPath('/health'), false);
    assert.equal(isPublicPath('/agent-io-steal'), false);
    // After the old paths all moved under /public, the root must not keep an exemption
    assert.equal(isPublicPath('/install.sh'), false);
    assert.equal(isPublicPath('/uninstall.sh'), false);
    assert.equal(isPublicPath('/lifeline.mjs'), false);
    assert.equal(isPublicPath('/cli-latest.txt'), false);
    assert.equal(isPublicPath('/api/cli-setup/exchange'), false);
    // The prefix must not be loosened to "starts with /public"
    assert.equal(isPublicPath('/public'), false);
    assert.equal(isPublicPath('/public-steal/x'), false);
    assert.equal(isPublicPath('/publicity/install.sh'), false);
  });

  it('normalises before matching so ../ cannot borrow the prefix', () => {
    // After normalisation, anything that escaped public/ is treated as needing auth
    assert.equal(isPublicPath('/public/../index.html'), false);
    assert.equal(isPublicPath('/public/%2e%2e/index.html'), false);
    assert.equal(isPublicPath('/public/%2E%2E/index.html'), false);
    assert.equal(isPublicPath('/public/a/../../index.html'), false);
    assert.equal(isPublicPath('/public/..%2findex.html'), false);
    // After normalisation, paths still inside public/ are still allowed
    assert.equal(isPublicPath('/public/./install.sh'), true);
    assert.equal(isPublicPath('/public/a/../install.sh'), true);
    // Do not guess at malformed percent-encoding
    assert.equal(isPublicPath('/public/%zz'), false);
    assert.equal(isPublicPath('/public/%'), false);
  });

  // Cross-check tarball names against the packer: a hand-copied list would miss one and never notice.
  it('allows exactly the tarball names the packer produces', () => {
    for (const { os, arch } of RUNTIME_TARGETS) {
      const name = runtimePackageName(os, arch);
      assert.equal(isPublicPath(`${PUBLIC_PREFIX}/${name}`), true, name);
      assert.equal(isPublicPath(`${PUBLIC_PREFIX}/${name}.sha256`), true, `${name}.sha256`);
    }
  });

  // The CLI prefix is a separate constant; if the two drift, downloads 403 — cross-check them here.
  it('keeps the CLI public prefix in sync with the server gate', () => {
    assert.equal(isPublicPath(`${PUBLIC_PREFIX}/${CLI_LATEST_FILE}`), true);
  });
});
