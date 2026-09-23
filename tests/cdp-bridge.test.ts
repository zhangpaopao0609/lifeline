import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAgentsDashboardPage,
  isProjectWindowPage,
  isRaiseMatched,
  pickWorkbenchTarget,
  raiseWindowAppleScript,
  raiseWindowCommand,
} from '../packages/agent/src/cdp/bridge.js';

const workbench = 'vscode-file://vscode-app/Applications/Cursor.app/workbench.html';

describe('pickWorkbenchTarget', () => {
  it('prefers a workspace page over Cursor Agents when reconnecting without an id', () => {
    const target = pickWorkbenchTarget([
      { id: 'agents', type: 'page', title: 'Cursor Agents', url: workbench, webSocketDebuggerUrl: 'ws://agents' },
      { id: 'ws', type: 'page', title: 'demo-repo', url: workbench, webSocketDebuggerUrl: 'ws://ws' },
    ]);
    assert.equal(target?.id, 'ws');
  });

  it('keeps an explicit preferred target even if it is Cursor Agents', () => {
    const target = pickWorkbenchTarget(
      [
        { id: 'agents', type: 'page', title: 'Cursor Agents', url: workbench, webSocketDebuggerUrl: 'ws://agents' },
        { id: 'ws', type: 'page', title: 'demo-repo', url: workbench, webSocketDebuggerUrl: 'ws://ws' },
      ],
      'agents',
    );
    assert.equal(target?.id, 'agents');
  });

  it('skips untitled vscode-file:// pages when a named workspace exists', () => {
    const target = pickWorkbenchTarget([
      {
        id: 'raw',
        type: 'page',
        title: 'vscode-file://vscode-app/Applications/Cursor.app/workbench.html',
        url: workbench,
        webSocketDebuggerUrl: 'ws://raw',
      },
      { id: 'ws', type: 'page', title: 'demo-repo', url: workbench, webSocketDebuggerUrl: 'ws://ws' },
    ]);
    assert.equal(target?.id, 'ws');
  });
});

describe('isProjectWindowPage', () => {
  const page = (title: string, url = workbench) => ({ id: title || 'x', type: 'page', title, url });

  it('treats the Cursor Agents dashboard as not-a-window (any casing)', () => {
    assert.equal(isAgentsDashboardPage(page('Cursor Agents')), true);
    assert.equal(isProjectWindowPage(page('Cursor Agents')), false);
    assert.equal(isProjectWindowPage(page('  cursor agents  ')), false);
  });

  it('treats CodeBuddy agentManager.html as not-a-window even when untitled', () => {
    const url = 'vscode-file://vscode-app/Applications/CodeBuddy CN.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/agentManager.html';
    assert.equal(isAgentsDashboardPage(page(url, url)), true);
    assert.equal(isProjectWindowPage(page(url, url)), false);
    // A project window in the same app is still a window
    assert.equal(
      isProjectWindowPage(page('demo-repo', 'vscode-file://vscode-app/Applications/CodeBuddy CN.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html')),
      true,
    );
  });

  it('keeps real project windows and drops non-workbench pages', () => {
    assert.equal(isProjectWindowPage(page('demo-repo')), true);
    assert.equal(isProjectWindowPage(page('Cursor Agents', 'file:///tmp/index.html')), false);
    assert.equal(
      isProjectWindowPage({ id: 'w', type: 'webview', title: 'demo-repo', url: workbench }),
      false,
    );
  });
});

describe('raiseWindowAppleScript', () => {
  it('activates Cursor by default and never mentions CodeBuddy', () => {
    const script = raiseWindowAppleScript('demo-repo', ['Cursor']);
    assert.match(script, /tell application "Cursor" to activate/);
    assert.match(script, /tell process "Cursor"/);
    assert.equal(/CodeBuddy/.test(script), false);
  });

  it('raises CodeBuddy without invoking Cursor', () => {
    const script = raiseWindowAppleScript('demo-repo', ['CodeBuddy CN', 'CodeBuddy']);
    assert.match(script, /"CodeBuddy CN"/);
    assert.match(script, /"CodeBuddy"/);
    assert.equal(/"Cursor"/.test(script), false);
    assert.equal(/tell application "Cursor"/.test(script), false);
    assert.equal(/tell process "Cursor"/.test(script), false);
  });
});

// Platform dispatch is a pure function so the win32 branch can be tested on macOS (otherwise the only conclusion is "never reached")
describe('raiseWindowCommand', () => {
  it('uses osascript with the AppleScript on darwin (equivalent to the old inline call)', () => {
    const cmd = raiseWindowCommand('darwin', 'demo-repo', ['Cursor']);
    assert.ok(cmd);
    assert.equal(cmd.cmd, 'osascript');
    // One line pins argument count, argument positions, and equivalence with the old inline call
    assert.deepEqual(cmd.args, ['-e', raiseWindowAppleScript('demo-repo', ['Cursor'])]);
  });

  it('uses PowerShell AppActivate on win32', () => {
    const cmd = raiseWindowCommand('win32', 'lifeline - Cursor', ['Cursor']);
    assert.ok(cmd);
    assert.equal(cmd.cmd, 'powershell.exe');
    const script = cmd.args[cmd.args.length - 1]!;
    assert.match(script, /WScript\.Shell/);
    assert.match(script, /AppActivate\('lifeline - Cursor'\)/);
  });

  // Unescaped single quotes in the title are a PowerShell syntax error
  it('escapes single quotes for the PowerShell string literal', () => {
    const cmd = raiseWindowCommand('win32', 'it\'s a window', []);
    assert.ok(cmd);
    assert.match(cmd.args[cmd.args.length - 1]!, /AppActivate\('it''s a window'\)/);
  });

  it('does nothing on unsupported platforms or with an empty title', () => {
    assert.equal(raiseWindowCommand('linux', 'x', []), null);
    assert.equal(raiseWindowCommand('win32', '', []), null);
    assert.equal(raiseWindowCommand('darwin', '', []), null);
  });
});

// The two platforms' "matched" criteria are completely different and easy to get wrong — pin them separately
describe('isRaiseMatched', () => {
  it('reads the osascript literal on darwin', () => {
    assert.equal(isRaiseMatched('darwin', 'matched\r\n'), true);
    assert.equal(isRaiseMatched('darwin', 'no-match\r\n'), false);
    // Windows True does not count as a match on macOS
    assert.equal(isRaiseMatched('darwin', 'True'), false);
  });

  it('reads the AppActivate boolean on win32', () => {
    assert.equal(isRaiseMatched('win32', 'True\r\n'), true);
    assert.equal(isRaiseMatched('win32', 'true'), true);
    assert.equal(isRaiseMatched('win32', 'False\r\n'), false);
    assert.equal(isRaiseMatched('win32', ''), false);
  });
});
