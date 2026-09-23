import assert from 'node:assert/strict';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  isSqliteAbiMismatch,
  rebuildBetterSqlite3,
  resolveNpmCli,
} from '../packages/agent/src/ensure-sqlite.js';

describe('isSqliteAbiMismatch', () => {
  it('detects NODE_MODULE_VERSION / compiled-against errors', () => {
    const err = new Error(
      'The module \'better_sqlite3.node\' was compiled against NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 137.',
    );
    (err as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
    assert.equal(isSqliteAbiMismatch(err), true);
  });

  it('ignores a missing package', () => {
    const err = new Error('Cannot find package \'better-sqlite3\'');
    (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    assert.equal(isSqliteAbiMismatch(err), false);
  });
});

describe('resolveNpmCli', () => {
  const NODE_DIR = '/opt/fnm';

  it('prefers npm-cli.js in the Windows layout (no lib/ in between)', () => {
    const nodeBin = join(NODE_DIR, 'node.exe');
    const win = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert.equal(resolveNpmCli(nodeBin, p => p === win, 'win32'), win);
  });

  // Measured: on Windows `<nodeDir>\npm` **does exist**, but it is a **shell script** for Git Bash;
  // handing it to node parses it as JS and fails; `npm.cmd` / `npm.ps1` need a shell to run.
  // So on win32 none of those three may be accepted — reordering is not enough; they must be excluded.
  // This is the only guard that distinguishes "exclude" from "just reorder": a half-baked impl can fool every other case.
  it('never picks npm / npm.cmd / npm.ps1 on Windows', () => {
    const nodeBin = join(NODE_DIR, 'node.exe');
    const scripts = [
      join(NODE_DIR, 'npm'),
      join(NODE_DIR, 'npm.cmd'),
      join(NODE_DIR, 'npm.ps1'),
    ];
    assert.equal(resolveNpmCli(nodeBin, p => p === scripts[0], 'win32'), null);
    assert.equal(resolveNpmCli(nodeBin, p => scripts.includes(p), 'win32'), null);
  });

  it('falls back to ../lib/node_modules/npm on POSIX layouts', () => {
    const nodeBin = join(NODE_DIR, 'bin', 'node');
    const fallback = join(NODE_DIR, 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert.equal(resolveNpmCli(nodeBin, p => p === fallback, 'linux'), fallback);
  });

  // On macOS / Linux `<nodeDir>/npm` is a symlink to npm-cli.js, so `node <that symlink>` is valid.
  it('still accepts the bare npm symlink on darwin and linux', () => {
    const bare = join(NODE_DIR, 'npm');
    for (const platform of ['darwin', 'linux'] as const) {
      assert.equal(resolveNpmCli(join(NODE_DIR, 'node'), p => p === bare, platform), bare);
    }
  });

  it('returns null when no npm exists at all (bundled runtime)', () => {
    assert.equal(resolveNpmCli(join(NODE_DIR, 'node.exe'), () => false, 'win32'), null);
  });
});

describe('rebuildBetterSqlite3', () => {
  it('runs npm via process.execPath, not PATH npm', () => {
    const nodeDir = join('/opt/fnm', 'bin');
    const nodeBin = join(nodeDir, 'node');
    // Use npm-cli.js rather than bare `npm`: bare npm is rejected by `resolveNpmCli` on Windows (it is a shell script)
    const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const calls: Array<{ bin: string; args: string[]; envPath: string }> = [];
    rebuildBetterSqlite3(nodeBin, '/tmp/agent-lib', {
      existsSync: p => p === npmCli,
      execFileSync: (bin, args, opts) => {
        calls.push({
          bin: String(bin),
          args: args.map(String),
          envPath: String((opts as { env?: { PATH?: string } })?.env?.PATH ?? ''),
        });
        return Buffer.from('');
      },
      log() {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, nodeBin);
    assert.deepEqual(calls[0].args, [npmCli, '--prefix', '/tmp/agent-lib', 'rebuild', 'better-sqlite3']);
    assert.ok(calls[0].envPath.startsWith(`${nodeDir}${delimiter}`));
    assert.equal(calls[0].envPath.includes(dirname(nodeBin)), true);
  });
});
