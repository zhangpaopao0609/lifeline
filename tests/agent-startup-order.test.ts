import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Source assertions for the startup order in `packages/agent/src/index.ts`.
 *
 * The order is the contract (spec: "one agent process per machine"): the lock is decided after
 * config load and before anything observable — driver banner, CDP probe (`detectLiveIdes`), and
 * the uplink — so a refused second process never registers. Nothing about this is visible from a
 * unit test of the pieces, hence the slice-and-compare here.
 */
const sourcePath = fileURLToPath(new URL('../packages/agent/src/index.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(sourcePath, 'utf-8');

/** A comment naming a call is not that call: the assertions must not be satisfied by prose. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
    .replace(/\s\/\/.*$/gm, '');
}

/** Body of `async function main()` up to the line that closes it, without the `main().catch` tail. */
function mainBody(): string {
  const start = source.indexOf('async function main(');
  assert.notEqual(start, -1, 'main() not found');
  const end = source.indexOf('\nmain().catch(', start);
  assert.notEqual(end, -1, 'main() tail not found');
  return stripComments(source.slice(start, end));
}

function positionOf(needle: string): number {
  const at = mainBody().indexOf(needle);
  assert.notEqual(at, -1, `missing in main(): ${needle}`);
  return at;
}

describe('agent startup order', () => {
  it('decides the lock before anything observable', () => {
    const lock = positionOf('acquireAgentLock(');
    assert.ok(lock < positionOf('new Uplink('), 'the lock must be taken before the uplink exists');
    assert.ok(lock < positionOf('detectLiveIdes('), 'the lock must be taken before any CDP probe');
    assert.ok(lock < positionOf('registeredDrivers()'), 'the lock must be taken before the driver banner');
    assert.ok(lock < positionOf('loadSelectors('), 'the lock must be the first line after config load');
  });

  it('prints nothing between the identity and the lock', () => {
    const body = mainBody();
    const identityAt = body.indexOf('const agentId =');
    const lock = body.indexOf('acquireAgentLock(');
    assert.notEqual(identityAt, -1, 'missing the identity line');
    assert.ok(identityAt < lock, 'the identity must be resolved before the lock');
    // "The refusal is this attempt's first line" holds only while nothing logs in between.
    assert.doesNotMatch(body.slice(identityAt, lock), /console\.(?:log|error|warn|info)\(/);
  });

  it('refuses with the formatted block and a non-zero exit before any registration', () => {
    const body = mainBody();
    const refusal = body.indexOf('if (!lock.ok)');
    assert.notEqual(refusal, -1, 'missing the refusal branch');
    // Structural slice, not a character budget: the branch ends where the success banner starts.
    // A fixed-size window silently passes once the branch grows past it (it did, with the flush).
    const end = body.indexOf('console.log(`[agent] pid=', refusal);
    assert.notEqual(end, -1, 'missing the success banner after the refusal branch');
    const branch = body.slice(refusal, end);
    assert.match(branch, /formatLockRefusal\(/);
    // The block must actually reach stderr: without this the whole refusal could be computed and
    // dropped, which is the silent no-op this change exists to remove.
    assert.match(branch, /console\.error\(line\)/, 'the refusal lines must reach stderr');
    assert.match(branch, /exitAfterFlush\(1\)/);
    // The identity handed to the refusal must carry the same four facts as the success banner —
    // it is what tells two dev machines apart in a supervisor log.
    assert.match(branch, /pid: process\.pid/);
    assert.match(branch, /agentId, version: BUILD_VERSION/);
    assert.match(branch, /remoteUrl: config\.remoteUrl/);
    assert.ok(!branch.includes('new Uplink('), 'the refusal path must not construct the uplink');
    assert.ok(
      !branch.includes('detectLiveIdes(') && !branch.includes('registeredDrivers('),
      'the refusal path must not probe CDP or print the driver banner',
    );
  });

  it('prints its identity on both paths and releases the lock on shutdown', () => {
    const body = mainBody();
    assert.match(
      body,
      /pid=\$\{process\.pid\} agentId=\$\{agentId\} v\$\{BUILD_VERSION\} remote=\$\{config\.remoteUrl\}/,
    );
    assert.match(body, /releaseAgentLock\(\)/);
  });
});

describe('agent superseded wiring', () => {
  /** The `uplink.on('superseded')` handler: from its registration to the next top-level `uplink.on(`. */
  function supersededHandler(): string {
    const body = mainBody();
    const at = body.indexOf(`uplink.on('superseded'`);
    assert.notEqual(at, -1, 'missing the superseded handler');
    const next = body.indexOf('uplink.on(', at + 1);
    return body.slice(at, next === -1 ? undefined : next);
  }

  it('decides through the tested unit and prints its lines', () => {
    const handler = supersededHandler();
    // The rule (stand down only for a superseder that names itself) lives in readSuperseded, where it
    // is unit-tested — reimplementing the check inline would put it out of reach of those tests.
    assert.match(handler, /readSuperseded\(payload\)/);
    assert.match(handler, /console\.warn/);
    assert.match(handler, /console\.error/);
    // Keeping the lock must not fall through into the exit path.
    assert.match(handler, /!standDown/);
  });

  it('stops talking, releases the lock, and only then exits', () => {
    const handler = supersededHandler();
    // The guard has to be *before* the side effects and has to be this literal: matching on the token
    // `!standDown` alone passes when the guard is moved after the exit, which is the very accident this
    // test exists for (the keep-the-lock row would then stand down instead).
    const guard = handler.indexOf('if (!standDown)');
    const enter = handler.indexOf('.shutdown(');
    assert.notEqual(guard, -1, 'missing the keep-the-lock guard');
    assert.notEqual(enter, -1, 'a stand-down must enter the shared shutdown');
    assert.ok(guard < enter, 'the guard must come before the side effects');
    assert.equal(handler.includes('process.exit'), false, 'a stand-down must not call process.exit');
    // Disconnect, release, and exit moved into lifecycle.ts with the rest of shutdown. The order is
    // unchanged: a socket that outlives the release could re-register during the flush, and a lock
    // released after the exit never happens. CLI and IDE close are textually before that trio.
    const lifecyclePath = fileURLToPath(new URL('../packages/agent/src/lifecycle.ts', import.meta.url));
    const lifecycle = stripComments(readFileSync(lifecyclePath, 'utf-8'));
    const closeCli = lifecycle.indexOf('closeCli()');
    const closeIde = lifecycle.indexOf('closeIde()');
    const disconnect = lifecycle.indexOf('disconnect()');
    const release = lifecycle.indexOf('releaseLock()');
    const exit = lifecycle.indexOf('exit(');
    assert.notEqual(closeCli, -1, 'shutdown must close CLI');
    assert.notEqual(closeIde, -1, 'shutdown must close IDE slots');
    assert.notEqual(disconnect, -1, 'a stand-down must stop talking to the server');
    assert.notEqual(release, -1, 'a stand-down must release the lock');
    assert.notEqual(exit, -1, 'a stand-down must exit');
    assert.ok(closeCli < disconnect && closeIde < disconnect, 'disconnect only after CLI and IDE close');
    assert.ok(disconnect < release, 'disconnect before releasing the lock');
    assert.ok(release < exit, 'the lock must be released before the process exits');
  });

  it('never reconnects, re-registers or syncs in reaction to the event', () => {
    const handler = supersededHandler();
    for (const forbidden of ['agent:register', 'sendFullState(', 'agent:sync', 'uplink.connect(', 'new Uplink('])
      assert.ok(!handler.includes(forbidden), `the superseded handler must not use ${forbidden}`);
  });
});

describe('agent startup first line', () => {
  it('loads config without printing, so the refusal or the banner comes first', () => {
    // `import 'dotenv/config'` is quiet; `dotenv.config()` without options prints "◇ injected env".
    // The first-line property depends on that choice, so it is asserted rather than assumed — and
    // on **both** streams: dotenv warns on stderr, which is where the refusal goes too.
    const configUrl = pathToFileURL(join(repoRoot, 'packages/agent/src/config.ts')).href;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('DOTENV_CONFIG_')),
    );
    const out = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(configUrl)}); console.log('MARK')`],
      { cwd: repoRoot, encoding: 'utf-8', env },
    );
    assert.equal(out.stderr.trim(), '');
    assert.equal(out.stdout.trim(), 'MARK');
  });
});
