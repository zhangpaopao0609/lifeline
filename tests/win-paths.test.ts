import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appDataDir,
  CODEBUDDY_IMAGE_NAMES,
  codeBuddyActivePortFileCandidates,
  codeBuddyArgvCandidates,
  codeBuddyDataRoot,
  codeBuddyExeCandidates,
  codeBuddyUserDataDirs,
  CURSOR_IMAGE_NAME,
  cursorActivePortFileCandidates,
  cursorArgvPath,
  cursorExeCandidates,
  cursorUserDataDir,
  cursorVscdbPath,
  findIdeExe,
  localAppDataDir,
  parseRegQueryDefaultValue,
  programFilesDir,
  programFilesDirX86,
  uninstallExeCandidatesFromRegQuery,
  uninstallParentKeys,
} from '../packages/agent/src/win-paths.js';

const HOME = 'C:\\Users\\tester';
const ENV = {
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
};

describe('win-paths', () => {
  it('uses APPDATA / LOCALAPPDATA when present', () => {
    assert.equal(appDataDir(ENV, HOME), ENV.APPDATA);
    assert.equal(localAppDataDir(ENV, HOME), ENV.LOCALAPPDATA);
  });

  // Fallback when env vars are missing: APPDATA can be empty in CI / slim service environments
  it('falls back under the home dir when the env vars are missing', () => {
    assert.equal(appDataDir({}, HOME), `${HOME}\\AppData\\Roaming`);
    assert.equal(localAppDataDir({}, HOME), `${HOME}\\AppData\\Local`);
  });

  it('resolves Cursor userData paths (实测：argv.json 与 DevToolsActivePort 都落在 userDataDir)', () => {
    assert.equal(cursorUserDataDir(ENV, HOME), `${ENV.APPDATA}\\Cursor`);
    assert.equal(
      cursorVscdbPath(ENV, HOME),
      `${ENV.APPDATA}\\Cursor\\User\\globalStorage\\state.vscdb`,
    );
    assert.equal(cursorArgvPath(ENV, HOME), `${ENV.APPDATA}\\Cursor\\argv.json`);
    assert.deepEqual(cursorActivePortFileCandidates(ENV, HOME), [
      `${ENV.APPDATA}\\Cursor\\DevToolsActivePort`,
    ]);
  });

  it('resolves CodeBuddy userData paths with CN first', () => {
    assert.deepEqual(codeBuddyUserDataDirs(ENV, HOME), [
      `${ENV.APPDATA}\\CodeBuddy CN`,
      `${ENV.APPDATA}\\CodeBuddy`,
    ]);
    assert.deepEqual(codeBuddyArgvCandidates(ENV, HOME), [
      `${ENV.APPDATA}\\CodeBuddy CN\\argv.json`,
      `${ENV.APPDATA}\\CodeBuddy\\argv.json`,
    ]);
    assert.deepEqual(codeBuddyActivePortFileCandidates(ENV, HOME), [
      `${ENV.APPDATA}\\CodeBuddy CN\\DevToolsActivePort`,
      `${ENV.APPDATA}\\CodeBuddy\\DevToolsActivePort`,
    ]);
  });

  it('resolves the CodeBuddy content root (实测存在：Data\\<uid>\\CodeBuddyIDE\\<ws>\\history)', () => {
    assert.equal(
      codeBuddyDataRoot(ENV, HOME),
      `${ENV.LOCALAPPDATA}\\CodeBuddyExtension\\Data`,
    );
  });

  // Candidates are deliberately loose (R1 lesson: inventory miss cost is asymmetric; for relaunch, miss = never self-heal)
  it('lists install candidates; per-user first, then Program Files', () => {
    assert.deepEqual(cursorExeCandidates(ENV, HOME), [
      `${ENV.LOCALAPPDATA}\\Programs\\cursor\\Cursor.exe`,
      `${ENV.LOCALAPPDATA}\\Programs\\Cursor\\Cursor.exe`,
      'C:\\Program Files\\Cursor\\Cursor.exe',
      'C:\\Program Files (x86)\\Cursor\\Cursor.exe',
    ]);
    assert.deepEqual(codeBuddyExeCandidates(ENV, HOME), [
      `${ENV.LOCALAPPDATA}\\Programs\\CodeBuddy CN\\CodeBuddy CN.exe`,
      `${ENV.LOCALAPPDATA}\\Programs\\CodeBuddy\\CodeBuddy.exe`,
      'C:\\Program Files\\CodeBuddy CN\\CodeBuddy CN.exe',
      'C:\\Program Files\\CodeBuddy\\CodeBuddy.exe',
      'C:\\Program Files (x86)\\CodeBuddy CN\\CodeBuddy CN.exe',
      'C:\\Program Files (x86)\\CodeBuddy\\CodeBuddy.exe',
    ]);
  });

  // The system drive is not always C:, and localized Windows may rename folders — must read env vars
  it('takes Program Files from the environment, not a hard-coded C:', () => {
    const custom = { ...ENV, 'ProgramFiles': 'D:\\PF', 'ProgramFiles(x86)': 'D:\\PF86' };
    assert.equal(programFilesDir(custom), 'D:\\PF');
    assert.equal(programFilesDirX86(custom), 'D:\\PF86');
    assert.equal(cursorExeCandidates(custom, HOME)[2], 'D:\\PF\\Cursor\\Cursor.exe');
    assert.equal(cursorExeCandidates(custom, HOME)[3], 'D:\\PF86\\Cursor\\Cursor.exe');
  });

  it('falls back to the C: defaults when neither ProgramFiles var is set', () => {
    assert.equal(programFilesDir(ENV), 'C:\\Program Files');
    assert.equal(programFilesDirX86(ENV), 'C:\\Program Files (x86)');
  });

  // Env vars may be only half-set (32-bit shell / slim environment)
  it('handles a half-set environment (ProgramFiles set, x86 missing)', () => {
    const half = { ...ENV, ProgramFiles: 'D:\\PF' };
    assert.equal(programFilesDir(half), 'D:\\PF');
    assert.equal(programFilesDirX86(half), 'C:\\Program Files (x86)');
  });

  it('exposes the image names used by tasklist/taskkill (实测 CodeBuddy 带空格)', () => {
    assert.equal(CURSOR_IMAGE_NAME, 'Cursor.exe');
    assert.deepEqual(CODEBUDDY_IMAGE_NAMES, ['CodeBuddy CN.exe', 'CodeBuddy.exe']);
  });
});

// Real `reg query` output looks like (`/ve` takes only the default value):
// HKEY_LOCAL_MACHINE\SOFTWARE\...\App Paths\Cursor.exe
//     (Default)    REG_SZ    C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe
describe('parseRegQueryDefaultValue', () => {
  it('reads the REG_SZ default value', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe',
      '    (Default)    REG_SZ    C:\\Program Files\\Cursor\\Cursor.exe',
      '',
    ].join('\r\n');
    assert.equal(parseRegQueryDefaultValue(out), 'C:\\Program Files\\Cursor\\Cursor.exe');
  });

  // %VAR% in REG_EXPAND_SZ **must** be expanded: without it existsSync('%ProgramFiles%\…') is always false,
  // and those entries are silently skipped — yet that is exactly the form App Paths fallback most needs to cover.
  it('expands REG_EXPAND_SZ using the environment', () => {
    const out = '    (Default)    REG_EXPAND_SZ    "%ProgramFiles%\\Cursor\\Cursor.exe"';
    assert.equal(
      parseRegQueryDefaultValue(out, { ProgramFiles: 'C:\\PF' }),
      'C:\\PF\\Cursor\\Cursor.exe',
    );
  });

  it('leaves REG_SZ alone and strips surrounding quotes', () => {
    const out = '    (Default)    REG_SZ    "C:\\Program Files\\Cursor\\Cursor.exe"';
    assert.equal(parseRegQueryDefaultValue(out, {}), 'C:\\Program Files\\Cursor\\Cursor.exe');
  });

  it('keeps an unknown %VAR% untouched', () => {
    const out = '    (Default)    REG_EXPAND_SZ    %NoSuchVar%\\Cursor.exe';
    assert.equal(parseRegQueryDefaultValue(out, {}), '%NoSuchVar%\\Cursor.exe');
  });

  it('returns undefined for an empty default value', () => {
    assert.equal(parseRegQueryDefaultValue('    (Default)    REG_SZ    ', {}), undefined);
  });

  // Regression (measured): on Chinese Windows `windowsHide: true` makes reg.exe use the OEM/ANSI
  // code page, so the default-value label is localized. Matching the literal `(Default)` makes the
  // whole App Paths fallback **silently fail** — matching on value type covers both forms.
  it('matches by value type, not by the (localised, possibly mojibake) default label', () => {
    assert.equal(
      parseRegQueryDefaultValue('    (默认)    REG_SZ    C:\\Program Files\\Cursor\\Cursor.exe', {}),
      'C:\\Program Files\\Cursor\\Cursor.exe',
    );
    assert.equal(
      parseRegQueryDefaultValue('    (Ĭ��)    REG_SZ    C:\\Program Files\\Cursor\\Cursor.exe', {}),
      'C:\\Program Files\\Cursor\\Cursor.exe',
    );
  });

  it('resolves %VAR% case-insensitively (the registry often writes lowercase)', () => {
    const out = '    (Default)    REG_EXPAND_SZ    %programfiles%\\Cursor\\Cursor.exe';
    assert.equal(parseRegQueryDefaultValue(out, { ProgramFiles: 'C:\\PF' }), 'C:\\PF\\Cursor\\Cursor.exe');
  });

  it('returns undefined when the key or value is missing', () => {
    assert.equal(parseRegQueryDefaultValue(''), undefined);
    assert.equal(parseRegQueryDefaultValue('ERROR: The system was unable to find the specified registry key'), undefined);
  });
});

// 2026-09-21 on-machine root cause: with Cursor installed at `D:\Program Files\cursor`,
// the candidate table (%LOCALAPPDATA%\Programs, %ProgramFiles%) all miss, and Cursor's Inno
// installer **does not register App Paths** (HKCU / HKLM both measured `unable to find`) →
// self-heal is completely dead. Uninstall entries' `InstallLocation` / `DisplayIcon` are the
// only place the real install dir remains.
// The command is `reg query <parent> /s /f <needle> /d`; measured it **prints only matching
// value lines** (unmatched values under the same key are not printed):
// ```
// HKEY_CURRENT_USER\SOFTWARE\...\Uninstall\{DADADADA-...}}_is1
//     DisplayIcon    REG_SZ    C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe
//
// End of search: 1 match(es) found.
// ```
describe('uninstallExeCandidatesFromRegQuery', () => {
  // HKCU first: per-user installs (measured here for both Cursor and CodeBuddy) register in HKCU.
  // HKLM\WOW6432Node is the 32-bit installer view; Node x64 is not redirected automatically, so list it explicitly.
  it('lists the Uninstall parents: HKCU first, then HKLM, then the 32-bit view', () => {
    assert.deepEqual(uninstallParentKeys(), [
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]);
  });

  it('derives the exe from InstallLocation (trailing backslash is the normal form)', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{DADADADA-ADAD-ADAD-ADAD-ADADADADADAD}}_is1',
      '    InstallLocation    REG_SZ    D:\\Program Files\\cursor\\',
      '    DisplayName    REG_SZ    Cursor (User)',
      '',
      'End of search: 2 match(es) found.',
      '',
    ].join('\r\n');
    assert.deepEqual(uninstallExeCandidatesFromRegQuery(out, 'Cursor.exe'), [
      'D:\\Program Files\\cursor\\Cursor.exe',
    ]);
  });

  it('takes a DisplayIcon that is the exe itself, stripping quotes and the icon index', () => {
    const out = '    DisplayIcon    REG_SZ    "D:\\Program Files\\cursor\\Cursor.exe",0';
    assert.deepEqual(uninstallExeCandidatesFromRegQuery(out, 'Cursor.exe'), [
      'D:\\Program Files\\cursor\\Cursor.exe',
    ]);
  });

  // Installers with only UninstallString (common for NSIS): the uninstaller lives in the install dir; take its directory.
  it('falls back to the uninstaller directory when only UninstallString is registered', () => {
    const out = '    UninstallString    REG_SZ    "D:\\Program Files\\cursor\\unins000.exe"';
    assert.deepEqual(uninstallExeCandidatesFromRegQuery(out, 'Cursor.exe'), [
      'D:\\Program Files\\cursor\\Cursor.exe',
    ]);
  });

  it('expands REG_EXPAND_SZ', () => {
    const out = '    InstallLocation    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\cursor\\';
    assert.deepEqual(
      uninstallExeCandidatesFromRegQuery(out, 'Cursor.exe', {
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      }),
      ['C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe'],
    );
  });

  // A real machine had a Chrome web-app entry: DisplayName=Cursor, DisplayIcon pointing at a .ico.
  // Treating that as an exe would make self-heal spawn an icon — only accept "the value itself is an exe path" or known directory-typed values.
  it('ignores DisplayName and non-exe DisplayIcon (the Chrome web-app entry)', () => {
    const out = [
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\2891e1c930371fbc40abfb0686b82f25',
      '    DisplayName    REG_SZ    Cursor',
      '    DisplayIcon    REG_SZ    C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Web Applications\\_crx_x\\Cursor.ico',
      '',
      'End of search: 2 match(es) found.',
    ].join('\r\n');
    assert.deepEqual(uninstallExeCandidatesFromRegQuery(out, 'Cursor.exe'), []);
  });

  it('dedupes the same path seen through two value names', () => {
    const out = [
      '    InstallLocation    REG_SZ    D:\\Apps\\cursor\\',
      '    DisplayIcon    REG_SZ    D:\\Apps\\cursor\\Cursor.exe',
    ].join('\r\n');
    assert.deepEqual(uninstallExeCandidatesFromRegQuery(out, 'Cursor.exe'), [
      'D:\\Apps\\cursor\\Cursor.exe',
    ]);
  });

  // CodeBuddy's exe name has a space (`CodeBuddy CN.exe`): directory assembly must not split on the first space
  it('derives whatever exe name it was asked for (CodeBuddy CN)', () => {
    const out = '    InstallLocation    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\CodeBuddy CN\\';
    assert.deepEqual(uninstallExeCandidatesFromRegQuery(out, 'CodeBuddy CN.exe'), [
      'C:\\Users\\me\\AppData\\Local\\Programs\\CodeBuddy CN\\CodeBuddy CN.exe',
    ]);
  });

  it('returns [] on no matches / reg errors', () => {
    assert.deepEqual(uninstallExeCandidatesFromRegQuery('', 'Cursor.exe'), []);
    assert.deepEqual(uninstallExeCandidatesFromRegQuery('\r\nEnd of search: 0 match(es) found.\r\n', 'Cursor.exe'), []);
  });
});

describe('findIdeExe', () => {
  const EXES = ['Cursor.exe'];
  const CANDIDATES = ['C:\\a\\Cursor.exe', 'C:\\b\\Cursor.exe'];

  it('prefers a candidate that actually exists', () => {
    const found = findIdeExe(CANDIDATES, EXES, { exists: p => p === 'C:\\b\\Cursor.exe' });
    assert.equal(found, 'C:\\b\\Cursor.exe');
  });

  // App Paths is the fallback when "inventory miss": machines installed to a non-standard dir self-heal via it (R1: miss cost is asymmetric).
  // **HKCU must come first**: per-user installs (measured here) often register there.
  it('falls back to App Paths (HKCU before HKLM) when no candidate exists', () => {
    const asked: string[] = [];
    const found = findIdeExe(CANDIDATES, EXES, {
      exists: p => p === 'D:\\weird\\Cursor.exe',
      queryRegistry: (key) => {
        asked.push(key);
        return '    (Default)    REG_SZ    D:\\weird\\Cursor.exe';
      },
    });
    assert.equal(found, 'D:\\weird\\Cursor.exe');
    assert.deepEqual(asked, [
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe',
    ]);
  });

  it('also tries HKLM when HKCU has nothing', () => {
    const asked: string[] = [];
    const found = findIdeExe(CANDIDATES, EXES, {
      exists: p => p === 'D:\\hklm\\Cursor.exe',
      queryRegistry: (key) => {
        asked.push(key);
        return key.startsWith('HKLM')
          ? '    (Default)    REG_SZ    D:\\hklm\\Cursor.exe'
          : undefined;
      },
    });
    assert.equal(found, 'D:\\hklm\\Cursor.exe');
    assert.equal(asked[0]!.startsWith('HKCU'), true);
    assert.equal(asked[1]!.startsWith('HKLM'), true);
  });

  it('ignores a registry path that does not exist on disk', () => {
    const found = findIdeExe(CANDIDATES, EXES, {
      exists: () => false,
      queryRegistry: () => '    (Default)    REG_SZ    D:\\gone\\Cursor.exe',
    });
    assert.equal(found, undefined);
  });

  it('returns undefined when there is no registry hook at all', () => {
    assert.equal(findIdeExe(CANDIDATES, EXES, { exists: () => false }), undefined);
  });

  // Field regression (2026-09-21 on machine): Cursor installed at `D:\Program Files\cursor`.
  // Candidate table miss + empty App Paths (Cursor's Inno installer does not register) → previously only `skipped-no-exe`:
  // **neither error nor restart**, the user only sees "cannot connect", and that log line still prints only once.
  it('falls back to the Uninstall registry when candidates and App Paths both miss', () => {
    const asked: string[] = [];
    const found = findIdeExe(CANDIDATES, EXES, {
      exists: p => p === 'D:\\Program Files\\cursor\\Cursor.exe',
      queryRegistry: () => undefined,
      queryUninstall: (parent, needle) => {
        asked.push(`${parent}|${needle}`);
        return '    InstallLocation    REG_SZ    D:\\Program Files\\cursor\\';
      },
    });
    assert.equal(found, 'D:\\Program Files\\cursor\\Cursor.exe');
    assert.deepEqual(asked, [
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall|Cursor',
    ]);
  });

  // Fallback has a cost (a full subkey search); when App Paths hits, it must not scan even once
  it('does not scan the Uninstall keys when App Paths already resolved', () => {
    let uninstallScans = 0;
    const found = findIdeExe(CANDIDATES, EXES, {
      exists: p => p === 'C:\\apps\\Cursor.exe',
      queryRegistry: () => '    (Default)    REG_SZ    C:\\apps\\Cursor.exe',
      queryUninstall: () => {
        uninstallScans += 1;
        return undefined;
      },
    });
    assert.equal(found, 'C:\\apps\\Cursor.exe');
    assert.equal(uninstallScans, 0);
  });

  it('scans Uninstall parents in order, one exe name at a time', () => {
    const asked: string[] = [];
    const found = findIdeExe(['C:\\none.exe'], ['CodeBuddy CN.exe', 'CodeBuddy.exe'], {
      exists: p => p === 'D:\\cb\\CodeBuddy.exe',
      queryUninstall: (parent, needle) => {
        asked.push(`${needle}|${parent}`);
        return needle === 'CodeBuddy' ? '    InstallLocation    REG_SZ    D:\\cb\\' : undefined;
      },
    });
    assert.equal(found, 'D:\\cb\\CodeBuddy.exe');
    assert.deepEqual(asked, [
      'CodeBuddy CN|HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'CodeBuddy CN|HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'CodeBuddy CN|HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'CodeBuddy|HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]);
  });
});
