import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// Running POSIX scripts on Windows needs Git's bundled `sh` and "path → POSIX" — see tests/posix-tools.ts
import { POSIX_SH, shimPathForm, toPosixPath } from './posix-tools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/web/public/uninstall.sh');

const ARGV_WITH_MARKER = `{
\t"enable-crash-reporter": true,
\t// Lifeline CDP
\t"remote-debugging-port": 9222
}
`;

const ARGV_USER_OWNED = `{
\t"remote-debugging-port": 9222
}
`;

function writeStubLaunchctl(dir: string, logFile: string): void {
  const stub = join(dir, 'launchctl');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$UNINSTALL_LAUNCHCTL_LOG"\nexit 0\n`,
  );
  chmodSync(stub, 0o755);
  void logFile;
}

function writeStubSystemctl(dir: string): void {
  const stub = join(dir, 'systemctl');
  writeFileSync(stub, '#!/bin/sh\nexit 1\n');
  chmodSync(stub, 0o755);
}

/**
 * `pgrep` must be stubbed out: a real pgrep scans the **whole-machine process table**, which HOME cannot isolate.
 * The script's "orphan agent" cleanup does `pgrep -f runtime/lifeline\.mjs`, so it reports the real agent
 * running on the developer machine (`~/.lifeline/runtime/lifeline.mjs start`), then `kill -TERM` —
 * one `npm test` kill the local daemon (exit 0, and launchd KeepAlive.SuccessfulExit=false will not bring it back).
 * Default returns no pid; inject UNINSTALL_PGREP_OUT to test the orphan branch.
 */
function writeStubPgrep(dir: string): void {
  const stub = join(dir, 'pgrep');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ -n "\${UNINSTALL_PGREP_OUT:-}" ]; then printf '%s\\n' "$UNINSTALL_PGREP_OUT"; fi
exit 0
`,
  );
  chmodSync(stub, 0o755);
}

function writeStubNpm(dir: string, logFile: string, exitCode = 0): void {
  const stub = join(dir, 'npm');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$UNINSTALL_NPM_LOG"\nexit ${exitCode}\n`,
  );
  chmodSync(stub, 0o755);
  void logFile;
}

function runUninstall(
  home: string,
  binDir: string,
  stubDir: string,
  logFile: string,
  extra: {
    pathPrefix?: string;
    pathSuffix?: string;
    npmLog?: string;
    omitNodeDir?: boolean;
    pgrepOut?: string;
  } = {},
) {
  const pathParts = [
    extra.pathPrefix,
    stubDir,
    extra.pathSuffix,
    extra.omitNodeDir ? undefined : dirname(process.execPath),
    '/usr/bin',
    '/bin',
    // `xz.exe` lives in Git's mingw64\bin (GNU tar's -J depends on it) — see tests/posix-tools.ts
    '/mingw64/bin',
  ]
    .filter((p): p is string => Boolean(p))
    // ⚠️ Convert everything to POSIX form: `:` in a Windows path is treated as a PATH separator by the shell
    // (`C:\Program Files\nodejs` also has spaces); `/c/Program Files/nodejs` is the right form
    .map(toPosixPath);
  return spawnSync(POSIX_SH, [SCRIPT], {
    env: {
      ...process.env,
      HOME: toPosixPath(home),
      PATH: pathParts.join(':'),
      LIFELINE_BIN_DIR: toPosixPath(binDir),
      UNINSTALL_LAUNCHCTL_LOG: logFile,
      UNINSTALL_NPM_LOG: extra.npmLog ?? join(home, 'npm.log'),
      // Default empty = the pgrep stub returns nothing; never fall through to a real pgrep.
      UNINSTALL_PGREP_OUT: extra.pgrepOut ?? '',
    },
    encoding: 'utf-8',
  });
}

describe('uninstall.sh', () => {
  let home: string;
  let binDir: string;
  let stubDir: string;
  let logFile: string;
  let npmLog: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'uninstall-sh-'));
    binDir = join(home, 'bin');
    stubDir = join(home, 'stub');
    logFile = join(home, 'launchctl.log');
    npmLog = join(home, 'npm.log');
    mkdirSync(binDir);
    mkdirSync(stubDir);
    writeStubLaunchctl(stubDir, logFile);
    writeStubNpm(stubDir, npmLog);
    writeStubSystemctl(stubDir);
    writeStubPgrep(stubDir);
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.lifeline'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(home, '.lifeline', 'config.json'), '{"serverUrl":"x","agentToken":"y"}\n');
    writeFileSync(join(binDir, 'lifeline'), '#!/bin/sh\necho stub\n');
    // The old name must be left as-is: uninstall no longer understands AgentRemote.
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('strips marked CDP argv, deletes current config and CLI, and is idempotent', () => {
    writeFileSync(join(home, '.cursor', 'argv.json'), ARGV_WITH_MARKER);
    const plist = join(home, 'Library', 'LaunchAgents', 'com.lifeline.agent.plist');
    writeFileSync(plist, '<plist/>\n');

    const first = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(first.status, 0, first.stderr + first.stdout);

    const argv = readFileSync(join(home, '.cursor', 'argv.json'), 'utf-8');
    assert.equal(argv.includes('Lifeline CDP'), false);
    assert.doesNotMatch(argv, /"remote-debugging-port"/);
    assert.match(argv, /"enable-crash-reporter": true/);
    assert.equal(existsSync(join(home, '.lifeline')), false);
    assert.equal(existsSync(join(binDir, 'lifeline')), false);

    if (process.platform === 'darwin') {
      assert.equal(existsSync(plist), false);
      const log = readFileSync(logFile, 'utf-8');
      assert.match(log, /bootout gui\/\d+\/com\.lifeline\.agent/);
      assert.doesNotMatch(log, /com\.agentremote\.agent/);
    }
    else if (process.platform === 'linux') {
      assert.doesNotMatch(first.stdout, /^\s+daemon\s/m);
    }
    else {
      assert.match(first.stdout, /daemon\s+skipped \(unsupported platform\)/);
    }

    const second = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(second.status, 0, second.stderr + second.stdout);
  });

  it('leaves a pre-rename AgentRemote CDP marker alone', () => {
    const argvPath = join(home, '.cursor', 'argv.json');
    writeFileSync(argvPath, ARGV_WITH_MARKER.replace('Lifeline CDP', 'AgentRemote CDP'));

    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const argv = readFileSync(argvPath, 'utf-8');
    assert.match(argv, /AgentRemote CDP/);
    assert.match(argv, /"remote-debugging-port"/);
    assert.doesNotMatch(result.stdout, /^\s+cdp argv\s/m);
  });

  it('leaves user-owned remote-debugging-port when marker is absent', () => {
    writeFileSync(join(home, '.cursor', 'argv.json'), ARGV_USER_OWNED);
    const before = readFileSync(join(home, '.cursor', 'argv.json'), 'utf-8');
    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(join(home, '.cursor', 'argv.json'), 'utf-8'), before);
    // No marker of ours = we did not touch it, so the report has no cdp argv line.
    assert.doesNotMatch(result.stdout, /^\s+cdp argv\s/m);
  });

  it('strips marked CodeBuddy CN argv and leaves a user-owned CodeBuddy argv', () => {
    const cn = join(home, 'Library', 'Application Support', 'CodeBuddy CN', 'argv.json');
    const intl = join(home, 'Library', 'Application Support', 'CodeBuddy', 'argv.json');
    mkdirSync(dirname(cn), { recursive: true });
    mkdirSync(dirname(intl), { recursive: true });
    writeFileSync(cn, ARGV_WITH_MARKER.replace('9222', '9223'));
    writeFileSync(intl, ARGV_USER_OWNED);

    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const cnAfter = readFileSync(cn, 'utf-8');
    assert.equal(cnAfter.includes('Lifeline CDP'), false);
    assert.doesNotMatch(cnAfter, /"remote-debugging-port"/);
    assert.match(cnAfter, /"enable-crash-reporter": true/);
    assert.equal(readFileSync(intl, 'utf-8'), ARGV_USER_OWNED);
    // Report only the one file we actually changed; the user's own copy must not appear.
    assert.match(result.stdout, /cdp argv\s+stripped remote-debugging-port from 1 IDE file/);
  });

  it('strips marked CodeBuddy argv.json when only the international product exists', () => {
    const intl = join(home, 'Library', 'Application Support', 'CodeBuddy', 'argv.json');
    mkdirSync(dirname(intl), { recursive: true });
    writeFileSync(intl, ARGV_WITH_MARKER.replace('9222', '9223'));

    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const after = readFileSync(intl, 'utf-8');
    assert.equal(after.includes('Lifeline CDP'), false);
    assert.doesNotMatch(after, /"remote-debugging-port"/);
    assert.match(result.stdout, /cdp argv\s+stripped remote-debugging-port from 1 IDE file/);
  });

  it('strips CDP argv with bundled runtime node when PATH has no node', () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'argv.json'), ARGV_WITH_MARKER);
    const bundled = join(home, '.lifeline', 'runtime');
    mkdirSync(bundled, { recursive: true });
    writeFileSync(
      join(bundled, 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
    );
    chmodSync(join(bundled, 'node'), 0o755);
    const result = runUninstall(home, binDir, stubDir, logFile, { omitNodeDir: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cdp argv\s+stripped remote-debugging-port from 1 IDE file/);
    assert.equal(existsSync(join(home, '.cursor', 'argv.json')), true);
    const argv = readFileSync(join(home, '.cursor', 'argv.json'), 'utf-8');
    assert.equal(argv.includes('Lifeline CDP'), false);
    assert.equal(argv.includes('remote-debugging-port'), false);
  });

  it('runs npm uninstall -g lifeline when npm is on PATH', () => {
    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /cli\s+removed .*npm global lifeline/);
    const log = readFileSync(npmLog, 'utf-8');
    assert.match(log, /uninstall -g lifeline/);
  });

  it('skips npm global when npm is missing', () => {
    rmSync(join(stubDir, 'npm'));
    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog, omitNodeDir: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /npm global/);
    assert.equal(existsSync(npmLog), false);
  });

  it('does not fail the script when npm uninstall exits non-zero', () => {
    writeStubNpm(stubDir, npmLog, 1);
    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    // npm uninstalled nothing = the report does not mention it, but the local shim is still deleted.
    assert.doesNotMatch(result.stdout, /npm global/);
    assert.match(result.stdout, /cli\s+removed /);
    assert.equal(existsSync(join(binDir, 'lifeline')), false);
  });

  it('warns about a leftover lifeline on PATH without deleting it', () => {
    const extraDir = join(home, 'other-bin');
    mkdirSync(extraDir);
    const leftover = join(extraDir, 'lifeline');
    writeFileSync(leftover, '#!/bin/sh\necho leftover\n');
    chmodSync(leftover, 0o755);

    const result = runUninstall(home, binDir, stubDir, logFile, {
      npmLog,
      pathPrefix: extraDir,
      omitNodeDir: true,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    // The script sees the POSIX-form PATH we gave it, so what it prints is also `/c/...` (on Windows)
    assert.match(result.stdout, new RegExp(`still on PATH \\(${shimPathForm(leftover)}\\)`));
    assert.equal(existsSync(leftover), true);
  });

  it('still reports orphaned agents when pgrep matches something', () => {
    // pid does not exist; kill has no side effect.
    const result = runUninstall(home, binDir, stubDir, logFile, { npmLog, pgrepOut: '999999' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /agent\s+stopped 1 orphaned process\(es\)/);
  });
});

describe('install.sh uninstall hint', () => {
  it('prints curl uninstall.sh using BASE, and prefixes custom BIN_DIR', () => {
    const text = readFileSync(join(ROOT, 'packages/web/public/install.sh'), 'utf-8');
    assert.match(text, /To uninstall later:/);
    assert.match(text, /curl -fsSL \$BASE\/public\/uninstall\.sh \| sh/);
    assert.match(text, /curl -fsSL \$BASE\/public\/uninstall\.sh \| LIFELINE_BIN_DIR=/);
  });
});

describe('install.sh next steps', () => {
  it('prints lifeline setup; full path only if PATH is missing or another copy exists', () => {
    const text = readFileSync(join(ROOT, 'packages/web/public/install.sh'), 'utf-8');
    assert.match(text, /setup_cmd="lifeline setup --server-url \$BASE"/);
    assert.match(text, /another lifeline is on PATH/);
    assert.match(text, /\$BIN_DIR\/lifeline setup --server-url \$BASE/);
    assert.doesNotMatch(text, /Launch Cursor with CDP enabled/);
  });
});
