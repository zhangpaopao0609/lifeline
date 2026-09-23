import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DRIVERS } from '../packages/agent/src/drivers/index.js';
import { IDE_KINDS } from '../packages/protocol/src/index.js';

function configWith(cdpUrl: string, codebuddyCdpUrl: string) {
  return { cdpUrl, codebuddyCdpUrl } as Parameters<
    (typeof DRIVERS)[keyof typeof DRIVERS]['cdpUrlOf']
  >[0];
}

describe('drivers registry', () => {
  it('registers exactly the IDE_KINDS, each self-consistent', () => {
    assert.deepEqual(Object.keys(DRIVERS).sort(), [...IDE_KINDS].sort());
    for (const kind of IDE_KINDS) {
      assert.equal(DRIVERS[kind]?.kind, kind, `driver kind mismatch for ${kind}`);
    }
  });

  it('maps each kind to its configured CDP URL field', () => {
    const config = configWith('http://127.0.0.1:9222', 'http://127.0.0.1:9223');
    assert.equal(DRIVERS.cursor?.cdpUrlOf(config), 'http://127.0.0.1:9222');
    assert.equal(DRIVERS.codebuddy?.cdpUrlOf(config), 'http://127.0.0.1:9223');
  });

  it('portCandidates and argvPaths are non-empty arrays of the right shapes', () => {
    assert.ok(DRIVERS.cursor && DRIVERS.codebuddy);
    for (const driver of [DRIVERS.cursor, DRIVERS.codebuddy]) {
      const ports = driver.portCandidates();
      assert.ok(ports.length > 0, driver.kind);
      for (const p of ports) assert.ok(p.endsWith('DevToolsActivePort'), p);
      const argvs = driver.argvPaths();
      assert.ok(argvs.length > 0, driver.kind);
      for (const p of argvs) assert.ok(p.endsWith('argv.json'), p);
    }
  });

  it('bridgeOptions: codebuddy carries title suffixes + app names + relauncher; cursor defaults', () => {
    const cb = DRIVERS.codebuddy!.bridgeOptions();
    assert.ok((cb.titleSuffixes ?? []).length > 0);
    assert.ok((cb.appNames ?? []).length > 0);
    assert.ok(cb.relauncher !== undefined);

    const cur = DRIVERS.cursor!.bridgeOptions();
    // cursor takes CDPBridge defaults (titleSuffixes/appNames/relauncher all omitted)
    assert.equal(cur.titleSuffixes, undefined);
    assert.equal(cur.appNames, undefined);
    assert.equal(cur.relauncher, undefined);
  });

  it('hasLiveApp / attachLive / detachLive / waitUntilReady are functions on every driver', () => {
    for (const kind of IDE_KINDS) {
      const driver = DRIVERS[kind];
      assert.ok(driver, kind);
      assert.equal(typeof driver!.hasLiveApp, 'function');
      assert.equal(typeof driver!.attachLive, 'function');
      assert.equal(typeof driver!.detachLive, 'function');
      assert.equal(typeof driver!.waitUntilReady, 'function');
    }
  });

  it('factories exist (extraction and execution are per-driver)', () => {
    for (const kind of IDE_KINDS) {
      const driver = DRIVERS[kind];
      assert.equal(typeof driver!.createExtractor, 'function');
      assert.equal(typeof driver!.createExecutor, 'function');
    }
  });
});
