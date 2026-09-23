import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CliSetupCodes,
  isAllowedRedirectUri,
} from '../packages/server/src/cli-setup.js';

describe('isAllowedRedirectUri', () => {
  it('accepts loopback http callback with a port', () => {
    assert.equal(isAllowedRedirectUri('http://127.0.0.1:3847/callback'), true);
  });

  it('rejects localhost, other hosts, https, and extra paths', () => {
    assert.equal(isAllowedRedirectUri('http://localhost:3847/callback'), false);
    assert.equal(isAllowedRedirectUri('http://example.com/callback'), false);
    assert.equal(isAllowedRedirectUri('http://192.168.1.2:3847/callback'), false);
    assert.equal(isAllowedRedirectUri('https://127.0.0.1:3847/callback'), false);
    assert.equal(isAllowedRedirectUri('http://127.0.0.1:3847/other'), false);
    assert.equal(isAllowedRedirectUri('http://127.0.0.1:3847/callback/extra'), false);
    assert.equal(isAllowedRedirectUri('not a url'), false);
  });
});

describe('CliSetupCodes', () => {
  it('issues a code that can be exchanged once', () => {
    const store = new CliSetupCodes();
    const code = store.issue();
    assert.equal(code.length, 64);
    assert.equal(store.exchange(code), '');
    assert.equal(store.exchange(code), null);
  });

  it('hands back the userId that issued the code (machine ownership)', () => {
    const store = new CliSetupCodes();
    assert.equal(store.exchange(store.issue('alice')), 'alice');
  });

  it('rejects unknown codes', () => {
    const store = new CliSetupCodes();
    assert.equal(store.exchange('ab'.repeat(32)), null);
    assert.equal(store.exchange(''), null);
  });

  it('rejects expired codes', () => {
    let now = 1_000;
    const store = new CliSetupCodes(120_000, () => now);
    const code = store.issue('alice');
    now = 1_000 + 120_001;
    assert.equal(store.exchange(code), null);
  });
});
