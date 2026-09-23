import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  codeBuddyArgvCandidates,
  cursorArgvPath,
  removeCodeBuddyCdpArgv,
  resolveCodeBuddyArgvPath,
} from '../packages/cli/src/cdp-argv-file.js';
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
