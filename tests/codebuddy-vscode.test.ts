import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODEBUDDY_VSCODE_EXTENSION_PREFIX,
  VSCODE_APP_NAME,
  vscodeCodeBuddyPluginInstalled,
  vscodeExtensionsDir,
} from '../packages/agent/src/codebuddy-vscode.js';

describe('vscodeCodeBuddyPluginInstalled', () => {
  const home = '/u/fake-home';

  it('detects the coding-copilot extension in ~/.vscode/extensions', () => {
    assert.equal(
      vscodeCodeBuddyPluginInstalled({
        home,
        exists: p => p === vscodeExtensionsDir(home),
        readdir: () => ['ms-python.python-2025.1.0', `${CODEBUDDY_VSCODE_EXTENSION_PREFIX}-4.12.39997873`],
      }),
      true,
    );
  });

  it('returns false when the extensions dir exists but the plugin is absent', () => {
    assert.equal(
      vscodeCodeBuddyPluginInstalled({
        home,
        exists: () => true,
        readdir: () => ['ms-python.python-2025.1.0'],
      }),
      false,
    );
  });

  it('returns false when the extensions dir does not exist, and swallows readdir failures', () => {
    assert.equal(
      vscodeCodeBuddyPluginInstalled({ home, exists: () => false, readdir: () => [CODEBUDDY_VSCODE_EXTENSION_PREFIX] }),
      false,
    );
    assert.equal(
      vscodeCodeBuddyPluginInstalled({
        home,
        exists: () => true,
        readdir: () => {
          throw new Error('EACCES');
        },
      }),
      false,
    );
  });

  it('prefix-matches the publisher id, so a different publisher does not count', () => {
    assert.equal(
      vscodeCodeBuddyPluginInstalled({
        home,
        exists: () => true,
        readdir: () => ['someoneelse.coding-copilot-1.0.0'],
      }),
      false,
    );
  });
});

describe('vscodeExtensionsDir / VSCODE_APP_NAME', () => {
  it('uses ~/.vscode/extensions (same shape on every platform)', () => {
    assert.equal(vscodeExtensionsDir('/u/h'), '/u/h/.vscode/extensions');
  });
  it('exports the macOS app name used for quit/open/AXRaise', () => {
    assert.equal(VSCODE_APP_NAME, 'Visual Studio Code');
  });
});
