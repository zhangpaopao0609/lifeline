import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { canControlIde } from '../packages/agent/src/live-ides.js';
import {
  codeBuddyArgvCandidates,
  cursorArgvPath,
  ensureCodeBuddyCdpArgv,
  isVscodeArgvPath,
  removeCodeBuddyCdpArgv,
  resolveCodeBuddyArgvPath,
  resolveCodeBuddyArgvPaths,
} from '../packages/cli/src/cdp-argv-file.js';
import { cdpSummary } from '../packages/cli/src/cdp-argv-state.js';
import {
  ensureRemoteDebuggingPortInText,
  hasRemoteDebuggingPort,
  removeManagedRemoteDebuggingPort,
  setManagedRemoteDebuggingPort,
} from '../packages/cli/src/cdp-argv.js';

// Platform-specific argv path: the win32 value was measured from Electron's userDataDir (`%APPDATA%\Cursor`),
// **not** `~/.config`. `platform` / `env` are injectable, so the win32 branch can be tested on macOS.
describe('argv paths per platform', () => {
  const ENV = { APPDATA: 'C:\\u\\AppData\\Roaming' };

  it('points win32 Cursor at the Electron userDataDir', () => {
    assert.equal(cursorArgvPath('C:\\u', 'win32', ENV), 'C:\\u\\AppData\\Roaming\\Cursor\\argv.json');
  });

  it('keeps darwin on ~/.cursor and linux on ~/.config', () => {
    assert.equal(cursorArgvPath('/Users/x', 'darwin', ENV), join('/Users/x', '.cursor', 'argv.json'));
    assert.equal(cursorArgvPath('/home/x', 'linux', ENV), join('/home/x', '.config', 'Cursor', 'argv.json'));
  });

  it('lists win32 CodeBuddy argv candidates first, keeping the other platforms', () => {
    const win = codeBuddyArgvCandidates('C:\\u', 'win32', ENV);
    assert.equal(win[0], 'C:\\u\\AppData\\Roaming\\CodeBuddy CN\\argv.json');
    assert.equal(win[1], 'C:\\u\\AppData\\Roaming\\CodeBuddy\\argv.json');
    assert.equal(win.length, 6, '其余平台的候选仍要列出（卸载时清得干净）');
    assert.equal(
      win.some(p => p.split(/[\\/]/).includes('.config')),
      true,
      'Linux 候选仍应在列表里，只是排后面',
    );
  });

  it('lists the VSCode argv (plugin host) right after the current platform CodeBuddy entries when included', () => {
    // ⚠️ VSCode reads argv.json from ~/.vscode on ALL platforms — not userDataDir
    // like Cursor / CodeBuddy (measured on macOS 2026-11-03).
    const win = codeBuddyArgvCandidates('C:\\u', 'win32', ENV, { includeVscode: true });
    // host `join` on a POSIX test runner produces a mixed separator — same file, still first-after-CodeBuddy
    assert.equal(win[2], join('C:\\u', '.vscode', 'argv.json'));
    assert.equal(win.length, 7);

    const darwin = codeBuddyArgvCandidates('/Users/x', 'darwin', ENV, { includeVscode: true });
    assert.equal(darwin[2], join('/Users/x', '.vscode', 'argv.json'));
  });

  // ~/.vscode exists on every machine where VSCode ever ran, plugin or not —
  // the resolve path must not treat it as a CodeBuddy install without the gate.
  it('resolveCodeBuddyArgvPath only considers ~/.vscode when the plugin gate is on', () => {
    const home = '/tmp/fake-home';
    const exists = (p: string) => p === join(home, '.vscode');
    assert.equal(resolveCodeBuddyArgvPath(exists, home, { includeVscode: false }), null);
    assert.equal(
      resolveCodeBuddyArgvPath(exists, home, { includeVscode: true }),
      join(home, '.vscode', 'argv.json'),
    );
  });

  it('never puts a %APPDATA% path first on darwin or linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const list = codeBuddyArgvCandidates('/u', platform, ENV);
      assert.equal(list[0]?.includes('AppData'), false, `${platform} 的首选不该是 Windows 路径`);
    }
  });
});

const SAMPLE = `// header
{
\t"enable-crash-reporter": true,
\t"crash-reporter-id": "abc-123"
}
`;

describe('ensureRemoteDebuggingPortInText', () => {
  it('inserts the key before the closing brace and keeps comments', () => {
    const { text, changed } = ensureRemoteDebuggingPortInText(SAMPLE);
    assert.equal(changed, true);
    assert.match(text, /Lifeline CDP/);
    assert.match(text, /"remote-debugging-port": 9222/);
    assert.match(text, /"crash-reporter-id": "abc-123",/);
    assert.match(text, /\/\/ header/);
  });

  it('is a no-op when the key already exists', () => {
    const once = ensureRemoteDebuggingPortInText(SAMPLE).text;
    const twice = ensureRemoteDebuggingPortInText(once);
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once);
  });

  it('inserts 9223 when that port is requested', () => {
    const { text, changed } = ensureRemoteDebuggingPortInText(SAMPLE, 9223);
    assert.equal(changed, true);
    assert.match(text, /"remote-debugging-port": 9223/);
    assert.doesNotMatch(text, /"remote-debugging-port": 9222/);
  });
});

const MARKED_9222 = `{
\t"enable-crash-reporter": true,
\t// Lifeline CDP
\t"remote-debugging-port": 9222
}
`;

const AGENTREMOTE_9222 = `{
\t"enable-crash-reporter": true,
\t// AgentRemote CDP
\t"remote-debugging-port": 9222
}
`;

const MARKED_0 = `{
\t"enable-crash-reporter": true,
\t// Lifeline CDP
\t"remote-debugging-port": 0
}
`;

const UNMARKED = `{
\t"enable-crash-reporter": true,
\t"remote-debugging-port": 9222
}
`;

describe('setManagedRemoteDebuggingPort', () => {
  it('rewrites a Lifeline-marked 9222 to 0 and leaves the rest of the file', () => {
    const { text, changed, unmanaged } = setManagedRemoteDebuggingPort(MARKED_9222, 0);
    assert.equal(changed, true);
    assert.equal(unmanaged, undefined);
    assert.equal(text, MARKED_0);
  });

  it('rewrites an AgentRemote-marked 9222 to 0', () => {
    const { text, changed, unmanaged } = setManagedRemoteDebuggingPort(AGENTREMOTE_9222, 0);
    assert.equal(changed, true);
    assert.equal(unmanaged, undefined);
    assert.match(text, /"remote-debugging-port": 0/);
    assert.doesNotMatch(text, /"remote-debugging-port": 9222/);
    assert.match(text, /Lifeline CDP/);
    assert.doesNotMatch(text, /AgentRemote CDP/);
  });

  it('is a no-op when the marked port is already 0', () => {
    const { text, changed } = setManagedRemoteDebuggingPort(MARKED_0, 0);
    assert.equal(changed, false);
    assert.equal(text, MARKED_0);
  });

  it('does not change a single byte of an unmarked remote-debugging-port', () => {
    const { text, changed, unmanaged } = setManagedRemoteDebuggingPort(UNMARKED, 0);
    assert.equal(changed, false);
    assert.equal(unmanaged, true);
    assert.equal(text, UNMARKED);
  });

  it('inserts 0 when the key is missing', () => {
    const { text, changed } = setManagedRemoteDebuggingPort(SAMPLE, 0);
    assert.equal(changed, true);
    assert.match(text, /Lifeline CDP/);
    assert.match(text, /"remote-debugging-port": 0/);
    assert.doesNotMatch(text, /"remote-debugging-port": 9222/);
    assert.match(text, /\/\/ header/);
  });
});

const CN_ARGV = join(homedir(), 'Library', 'Application Support', 'CodeBuddy CN', 'argv.json');
const INTL_ARGV = join(homedir(), 'Library', 'Application Support', 'CodeBuddy', 'argv.json');

describe('resolveCodeBuddyArgvPath', () => {
  it('picks the CodeBuddy CN argv path when that product is present', () => {
    const path = resolveCodeBuddyArgvPath(p => p === CN_ARGV || p === dirname(CN_ARGV));
    assert.equal(path, CN_ARGV);
  });

  it('falls back to CodeBuddy when CN is not installed', () => {
    const path = resolveCodeBuddyArgvPath(p => p === INTL_ARGV || p === dirname(INTL_ARGV));
    assert.equal(path, INTL_ARGV);
  });

  it('returns null when neither product is installed', () => {
    assert.equal(resolveCodeBuddyArgvPath(() => false), null);
  });
});

describe('removeManagedRemoteDebuggingPort', () => {
  it('removes the marker and key, leaving other fields', () => {
    const added = ensureRemoteDebuggingPortInText(SAMPLE).text;
    const { text, changed } = removeManagedRemoteDebuggingPort(added);
    assert.equal(changed, true);
    assert.equal(hasRemoteDebuggingPort(text), false);
    assert.equal(text.includes('Lifeline CDP'), false);
    assert.match(text, /"crash-reporter-id": "abc-123"/);
    assert.doesNotMatch(text, /"crash-reporter-id": "abc-123",\s*\}/);
  });
});

const USER_OWNED_ARGV = `{
\t"remote-debugging-port": 9223
}
`;

describe('removeCodeBuddyCdpArgv', () => {
  let home: string;

  afterEach(() => {
    if (home)
      rmSync(home, { recursive: true, force: true });
  });

  it('leaves a user-owned remote-debugging-port when the Lifeline marker is absent', () => {
    home = mkdtempSync(join(tmpdir(), 'cb-argv-'));
    const cn = join(home, 'Library', 'Application Support', 'CodeBuddy CN', 'argv.json');
    mkdirSync(dirname(cn), { recursive: true });
    writeFileSync(cn, USER_OWNED_ARGV);

    assert.equal(removeCodeBuddyCdpArgv(home), false);
    assert.equal(readFileSync(cn, 'utf-8'), USER_OWNED_ARGV);
  });

  it('strips only the marked candidate when the other is user-owned', () => {
    home = mkdtempSync(join(tmpdir(), 'cb-argv-'));
    const cn = join(home, 'Library', 'Application Support', 'CodeBuddy CN', 'argv.json');
    const intl = join(home, 'Library', 'Application Support', 'CodeBuddy', 'argv.json');
    mkdirSync(dirname(cn), { recursive: true });
    mkdirSync(dirname(intl), { recursive: true });
    writeFileSync(cn, ensureRemoteDebuggingPortInText(SAMPLE, 9223).text);
    writeFileSync(intl, USER_OWNED_ARGV);

    assert.equal(removeCodeBuddyCdpArgv(home), true);
    assert.equal(readFileSync(cn, 'utf-8').includes('Lifeline CDP'), false);
    assert.doesNotMatch(readFileSync(cn, 'utf-8'), /"remote-debugging-port"/);
    assert.equal(readFileSync(intl, 'utf-8'), USER_OWNED_ARGV);
  });
});

describe('isVscodeArgvPath', () => {
  it('matches ~/.vscode/argv.json on both separators, and nothing else', () => {
    assert.equal(isVscodeArgvPath('/Users/x/.vscode/argv.json'), true);
    assert.equal(isVscodeArgvPath('C:\\Users\\x\\.vscode\\argv.json'), true);
    assert.equal(isVscodeArgvPath('/Users/x/Library/Application Support/CodeBuddy CN/argv.json'), false);
    assert.equal(isVscodeArgvPath('/Users/x/.cursor/argv.json'), false);
  });
});

describe('cdpSummary', () => {
  // The note branches on `canControlIde()` (Linux = content source only) and on
  // which argv.json we wrote. Telling a VSCode user "a manual restart is
  // pointless" is backwards — VSCode does read `remote-debugging-port`.
  const VSCODE_ARGV = '/Users/x/.vscode/argv.json';
  const IDE_ARGV = '/Users/x/Library/Application Support/CodeBuddy CN/argv.json';

  it('never tells a VSCode user that a manual restart is pointless', () => {
    const s = cdpSummary('already', 'wrote', { codebuddyPaths: [VSCODE_ARGV] });
    if (!canControlIde()) {
      assert.deepEqual(s.notes, ['This machine only reads session data (Linux); the debug port is not used here.']);
      return;
    }
    assert.equal(s.notes.some(n => n.includes('Do NOT restart')), false);
    assert.equal(s.notes.some(n => n.includes('VS Code')), true);
  });

  it('still warns the standalone-IDE user', () => {
    if (!canControlIde())
      return;
    const s = cdpSummary('already', 'wrote', { codebuddyPaths: [IDE_ARGV] });
    assert.equal(s.notes.some(n => n.includes('Do NOT restart CodeBuddy')), true);
  });

  it('says nothing when nothing was written', () => {
    if (!canControlIde())
      return;
    assert.deepEqual(cdpSummary('already', 'already', { codebuddyPaths: [IDE_ARGV] }).notes, []);
  });
});

describe('resolveCodeBuddyArgvPaths (P3: one file per host)', () => {
  const VSCODE_ARGV = join(homedir(), '.vscode', 'argv.json');

  // Dual install: both products' dirs exist. Before this, only the first one was
  // ever written, so a VSCode the user started themselves never had a port.
  it('returns every installed host, CodeBuddy first', () => {
    const paths = resolveCodeBuddyArgvPaths(
      p => p === CN_ARGV || p === dirname(CN_ARGV) || p === VSCODE_ARGV || p === dirname(VSCODE_ARGV),
      undefined,
      { includeVscode: true },
    );
    assert.equal(paths.length, 2);
    assert.equal(paths.includes(CN_ARGV), true);
    assert.equal(paths.includes(VSCODE_ARGV), true);
  });

  it('never includes ~/.vscode when the plugin gate is off', () => {
    const paths = resolveCodeBuddyArgvPaths(
      p => p === CN_ARGV || p === dirname(CN_ARGV) || p === VSCODE_ARGV || p === dirname(VSCODE_ARGV),
      undefined,
      { includeVscode: false },
    );
    assert.deepEqual(paths, [CN_ARGV]);
  });
});

describe('ensureCodeBuddyCdpArgv (P3: writes both hosts)', () => {
  let home: string;

  afterEach(() => {
    if (home)
      rmSync(home, { recursive: true, force: true });
  });

  it('writes the port into the standalone IDE AND the VSCode host', () => {
    home = mkdtempSync(join(tmpdir(), 'cb-argv-'));
    // The POSIX product layout is in the candidate list on every platform, so this
    // stays platform-independent (win32 candidates come from the real APPDATA).
    const cn = join(home, '.config', 'CodeBuddy CN', 'argv.json');
    const vscode = join(home, '.vscode', 'argv.json');
    mkdirSync(dirname(cn), { recursive: true });
    mkdirSync(dirname(vscode), { recursive: true });
    writeFileSync(cn, '{\n}\n');

    const outcome = ensureCodeBuddyCdpArgv(0, { includeVscode: true, home });
    // Order depends on which platform layout exists; membership is what matters.
    assert.deepEqual([...outcome.paths].sort(), [cn, vscode].sort());
    assert.deepEqual([...outcome.written].sort(), [cn, vscode].sort());
    assert.equal(outcome.state, 'created');
    assert.match(readFileSync(cn, 'utf-8'), /"remote-debugging-port": 0/);
    assert.match(readFileSync(vscode, 'utf-8'), /"remote-debugging-port": 0/);
  });

  it('is idempotent: a second run writes nothing', () => {
    home = mkdtempSync(join(tmpdir(), 'cb-argv-'));
    const cn = join(home, '.config', 'CodeBuddy CN', 'argv.json');
    const vscode = join(home, '.vscode', 'argv.json');
    mkdirSync(dirname(cn), { recursive: true });
    mkdirSync(dirname(vscode), { recursive: true });

    ensureCodeBuddyCdpArgv(0, { includeVscode: true, home });
    const again = ensureCodeBuddyCdpArgv(0, { includeVscode: true, home });
    assert.equal(again.state, 'already');
    assert.deepEqual(again.written, []);
    assert.deepEqual([...again.paths].sort(), [cn, vscode].sort());
  });

  // VSCode's own file may already carry a user-set key (we never re-serialize JSON,
  // and an unmarked key is left alone).
  it('leaves a user-owned remote-debugging-port in ~/.vscode/argv.json untouched', () => {
    home = mkdtempSync(join(tmpdir(), 'cb-argv-'));
    const vscode = join(home, '.vscode', 'argv.json');
    mkdirSync(dirname(vscode), { recursive: true });
    writeFileSync(vscode, USER_OWNED_ARGV);

    const outcome = ensureCodeBuddyCdpArgv(0, { includeVscode: true, home });
    assert.deepEqual(outcome.written, []);
    assert.equal(readFileSync(vscode, 'utf-8'), USER_OWNED_ARGV);
  });
});
