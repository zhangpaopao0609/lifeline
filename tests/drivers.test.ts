import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DRIVERS } from '../packages/agent/src/drivers/index.js';
import { IDE_KINDS } from '../packages/protocol/src/index.js';

function configWith(cdpUrl: string, codebuddyCdpUrl: string, vscodeCdpUrl: string) {
  return { cdpUrl, codebuddyCdpUrl, vscodeCdpUrl } as Parameters<
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
    const config = configWith('http://127.0.0.1:9222', 'http://127.0.0.1:9223', 'http://127.0.0.1:9225');
    assert.equal(DRIVERS.cursor?.cdpUrlOf(config), 'http://127.0.0.1:9222');
    assert.equal(DRIVERS.codebuddy?.cdpUrlOf(config), 'http://127.0.0.1:9223');
    assert.equal(DRIVERS.vscode?.cdpUrlOf(config), 'http://127.0.0.1:9225');
  });

  it('portCandidates and argvPaths are non-empty arrays of the right shapes', () => {
    assert.ok(DRIVERS.cursor && DRIVERS.codebuddy && DRIVERS.vscode);
    for (const driver of [DRIVERS.cursor, DRIVERS.codebuddy, DRIVERS.vscode]) {
      const ports = driver.portCandidates();
      assert.ok(ports.length > 0, driver.kind);
      for (const p of ports) assert.ok(p.endsWith('DevToolsActivePort'), p);
      const argvs = driver.argvPaths();
      assert.ok(argvs.length > 0, driver.kind);
      for (const p of argvs) assert.ok(p.endsWith('argv.json'), p);
    }
  });

  it('bridgeOptions: codebuddy carries suffixes + app names + relauncher + quietWake; cursor wires quietWake only', () => {
    const cb = DRIVERS.codebuddy!.bridgeOptions();
    assert.ok((cb.titleSuffixes ?? []).length > 0);
    assert.ok((cb.appNames ?? []).length > 0);
    assert.ok(cb.relauncher !== undefined);
    assert.equal(typeof cb.quietWake?.isRunning, 'function');

    const cur = DRIVERS.cursor!.bridgeOptions();
    // cursor 仍走 CDPBridge 默认 relauncher，但静默唤醒必须接进程探针
    assert.equal(cur.titleSuffixes, undefined);
    assert.equal(cur.appNames, undefined);
    assert.equal(cur.relauncher, undefined);
    assert.equal(typeof cur.quietWake?.isRunning, 'function');
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

describe('slot split: codebuddy vs vscode', () => {
  it('the codebuddy slot no longer claims VSCode as its live app', () => {
    // Injected exists: VSCode + the plugin are "installed", no CodeBuddy IDE.
    const home = '/u/fake-home';
    const exists = (p: string) =>
      p === `/Applications/Visual Studio Code.app` || p === `${home}/.vscode/extensions`;
    assert.equal(
      DRIVERS.codebuddy!.hasLiveApp(exists, home, 'darwin', {}),
      false,
      'codebuddy 槽不应再把 VSCode 宿主算作自己的 live app',
    );
  });

  it('the vscode slot is gated on the plugin and owns its own argv', () => {
    assert.equal(typeof DRIVERS.vscode!.isEnabled, 'function');
    const argv = DRIVERS.vscode!.argvPaths().map(p => p.replace(/\\/g, '/'));
    assert.deepEqual(argv.map(p => p.split('/').slice(-2).join('/')), ['.vscode/argv.json']);
  });

  // A disabled driver must not reach slot creation: `state:full` is built from this
  // list, and "status has the key" is what makes a rail row render. An empty state
  // per driver would bring the phantom row back.
  it('enabledDrivers drops a slot whose isEnabled is false', async () => {
    const { enabledDrivers } = await import('../packages/agent/src/drivers/index.js');
    const mk = (kind: 'a' | 'b', enabled?: boolean) => ({ kind, driver: { isEnabled: enabled === undefined ? undefined : () => enabled } }) as never;
    const out = enabledDrivers([mk('a', false), mk('b'), mk('a', true)] as never[]) as Array<{ kind: string }>;
    assert.deepEqual(out.map(row => row.kind), ['b', 'a']);
  });

  it('every slot in IDE_KINDS has a surface registered', async () => {
    const { SURFACE_OF, SURFACES } = await import('../packages/agent/src/drivers/index.js');
    for (const kind of IDE_KINDS)
      assert.ok(SURFACE_OF[kind] in SURFACES, kind);
  });
});
