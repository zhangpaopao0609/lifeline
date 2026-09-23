import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  fetchLatestVersion,
  isBundledRuntimeEntry,
  isNewer,
  parseVersionText,
  updateHint,
} from '../packages/cli/src/version.js';
import { isOutdated } from '../packages/web/src/lib/version.js';
import { cliVersion, writeLatestVersionFile } from '../scripts/build-cli.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('parseVersionText', () => {
  it('reads a bare x.y.z manifest and ignores trailing whitespace/newlines', () => {
    assert.equal(parseVersionText('0.1.52\n'), '0.1.52');
    assert.equal(parseVersionText('  0.1.52  '), '0.1.52');
  });

  it('returns null for anything that is not x.y.z', () => {
    assert.equal(parseVersionText(''), null);
    assert.equal(parseVersionText('\n'), null);
    assert.equal(parseVersionText('<!DOCTYPE html><html>signin</html>'), null);
    assert.equal(parseVersionText('v0.1.52'), null);
    assert.equal(parseVersionText('0.1.52-beta'), null);
    assert.equal(parseVersionText('0.1'), null);
  });
});

describe('compareVersions', () => {
  it('orders by numeric segments, not lexically', () => {
    assert.equal(compareVersions('0.1.52', '0.1.48'), 1);
    assert.equal(compareVersions('0.1.48', '0.1.52'), -1);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
    assert.equal(compareVersions('0.1.52', '0.1.52'), 0);
    assert.equal(compareVersions('0.2', '0.2.0'), 0);
  });

  it('treats unparsable segments as 0 instead of NaN', () => {
    assert.equal(compareVersions('0.0.0-dev', '0.0.0'), 0);
  });
});

describe('isNewer / updateHint', () => {
  it('only flags strictly newer releases', () => {
    assert.equal(isNewer('0.1.53', '0.1.52'), true);
    assert.equal(isNewer('0.1.52', '0.1.52'), false);
    // Local dev build is newer than the server: no prompt, no downgrade
    assert.equal(isNewer('0.1.51', '0.1.52'), false);
  });

  it('produces the status hint only when there is something to do', () => {
    assert.equal(updateHint('0.1.53', '0.1.52'), 'v0.1.53 available — run: lifeline update');
    assert.equal(updateHint('0.1.52', '0.1.52'), null);
    assert.equal(updateHint(null, '0.1.52'), null);
  });
});

describe('isBundledRuntimeEntry', () => {
  it('accepts paths under <home>/runtime and rejects npm installs', () => {
    const home = join(sep, 'home', 'u', '.lifeline');
    assert.equal(isBundledRuntimeEntry(join(home, 'runtime', 'lifeline.mjs'), home), true);
    assert.equal(
      isBundledRuntimeEntry(join(sep, 'opt', 'npm', 'lib', 'node_modules', 'lifeline', 'dist', 'cli', 'lifeline.mjs'), home),
      false,
    );
    assert.equal(isBundledRuntimeEntry(undefined, home), false);
  });
});

/** Serve one canned response and hand the base URL to `fn`. */
async function withServer(
  handler: (url: string | undefined) => { status: number; body: string },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const { status, body } = handler(req.url);
    res.statusCode = status;
    res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  }
  finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

describe('fetchLatestVersion', () => {
  it('GETs /public/cli-latest.txt even when the base has a trailing slash', async () => {
    const seen: string[] = [];
    await withServer(
      (url) => {
        if (url)
          seen.push(url);
        return { status: 200, body: '0.1.53\n' };
      },
      async (base) => {
        assert.equal(await fetchLatestVersion(`${base}/`), '0.1.53');
      },
    );
    assert.deepEqual(seen, ['/public/cli-latest.txt']);
  });

  it('returns null on 404, on a login-page body, and when nothing is listening', async () => {
    await withServer(
      () => ({ status: 404, body: 'not found' }),
      async base => assert.equal(await fetchLatestVersion(base), null),
    );
    await withServer(
      () => ({ status: 200, body: '<!DOCTYPE html><html>signin</html>' }),
      async base => assert.equal(await fetchLatestVersion(base), null),
    );

    let closedBase = '';
    await withServer(
      () => ({ status: 200, body: '0.1.53\n' }),
      async (base) => {
        closedBase = base;
      },
    );
    // Server is down: connection refused; must silently degrade rather than throw
    assert.equal(await fetchLatestVersion(closedBase, 1000), null);
  });
});

/** web is a separate subproject; the compare logic is a minimal copy of src/cli/version.ts — they must not drift. */
describe('web isOutdated', () => {
  it('agrees with the server-side comparison', () => {
    const cases: Array<[string, string]> = [
      ['0.1.48', '0.1.52'],
      ['0.1.52', '0.1.48'],
      ['0.1.52', '0.1.52'],
      ['0.9.9', '0.10.0'],
      ['0.2', '0.2.0'],
    ];
    for (const [cli, latest] of cases) {
      assert.equal(isOutdated(cli, latest), isNewer(latest, cli), `${cli} vs ${latest}`);
    }
  });

  it('stays silent when either side is not a real x.y.z version', () => {
    // Old agent with no version, npm-installed dev CLI (0.0.0-dev), server version unreadable (unknown)
    assert.equal(isOutdated(undefined, '0.1.52'), false);
    assert.equal(isOutdated('0.0.0-dev', '0.1.52'), false);
    assert.equal(isOutdated('0.1.48', 'unknown'), false);
    assert.equal(isOutdated('0.1.48', undefined), false);
  });
});

describe('cli version source', () => {
  it('build:cli injects package.json version and publishes the manifest', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    assert.equal(cliVersion(ROOT), pkg.version);
  });

  it('writes a one-line manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-latest-'));
    try {
      const path = join(dir, 'cli-latest.txt');
      writeLatestVersionFile('9.9.9', path);
      assert.equal(readFileSync(path, 'utf-8'), '9.9.9\n');
      assert.equal(parseVersionText(readFileSync(path, 'utf-8')), '9.9.9');
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never hand-writes the version into the CLI source again', () => {
    // Version is taken only from the build-time constant in packages/cli/src/build-version.ts; both CLI and agent import it
    const shared = readFileSync(join(ROOT, 'packages/cli/src/build-version.ts'), 'utf-8');
    assert.match(shared, /__CLI_VERSION__/);
    const cli = readFileSync(join(ROOT, 'packages/cli/src/index.ts'), 'utf-8');
    assert.match(cli, /BUILD_VERSION as VERSION/);
    assert.doesNotMatch(cli, /const VERSION = '\d+\.\d+\.\d+'/);
    const agent = readFileSync(join(ROOT, 'packages/agent/src/uplink.ts'), 'utf-8');
    assert.match(agent, /BUILD_VERSION/);
  });
});
