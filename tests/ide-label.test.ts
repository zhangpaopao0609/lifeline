import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ideSubject, ideTitle } from '../packages/web/src/lib/ide-label.ts';

describe('ideTitle', () => {
  it('adds nothing for the standalone IDE (the product name is the truth)', () => {
    assert.equal(ideTitle('codebuddy', 'ide'), 'CodeBuddy');
  });

  // The whole point of the label: a plugin-only machine must not tell the user to open CodeBuddy.
  it('names the VSCode plugin host', () => {
    assert.equal(ideTitle('codebuddy', 'vscode'), 'CodeBuddy · VS Code 插件');
  });

  it('never guesses when the host is unknown (old agent / never connected)', () => {
    assert.equal(ideTitle('codebuddy', undefined), 'CodeBuddy');
  });

  it('leaves Cursor alone (no plugin host exists for it)', () => {
    assert.equal(ideTitle('cursor', 'vscode'), 'Cursor');
    assert.equal(ideTitle('cursor', undefined), 'Cursor');
  });

  // Slot = host: the split slot's label already names the app, so it must not read
  // "VS Code · VS Code 插件".
  it('does not repeat the app name for the vscode slot', () => {
    assert.equal(ideTitle('vscode', 'vscode'), 'VS Code');
    assert.equal(ideTitle('vscode', undefined), 'VS Code');
  });
});

describe('ideSubject', () => {
  it('names the app the status sentence would quit / reopen', () => {
    assert.equal(ideSubject('codebuddy', 'ide'), 'CodeBuddy');
    assert.equal(ideSubject('codebuddy', 'vscode'), 'VS Code');
    assert.equal(ideSubject('codebuddy', undefined), 'CodeBuddy');
    assert.equal(ideSubject('cursor', undefined), 'Cursor');
  });

  it('produces copy that names the right app', () => {
    // Mirrors cdp-issue-copy's skipped-not-running string.
    const text = `${ideSubject('codebuddy', 'vscode')} 没在运行，打开它即可`;
    assert.equal(text, 'VS Code 没在运行，打开它即可');
  });
});
