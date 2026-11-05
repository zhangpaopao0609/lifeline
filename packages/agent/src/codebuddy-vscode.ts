import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The CodeBuddy **VSCode plugin** flavor: the same coding-copilot extension
 * (`tencent-cloud.coding-copilot`) hosted by regular VSCode instead of the
 * standalone CodeBuddy IDE.
 *
 * The wire/data model is identical in both hosts — same webview DOM (the
 * extractor/executor work unchanged), same history root
 * `CodeBuddyExtension/Data` (the plugin writes under `<uid>/VSCode/`, the IDE
 * under `<uid>/CodeBuddyIDE/`) — so the `codebuddy` IDE kind covers both and
 * no protocol / web / server change is needed. Everything that differs is
 * "which app to launch, and where its DevToolsActivePort / argv.json live".
 *
 * ⚠️ Every such VScode-aware behavior MUST be gated on the plugin being
 * installed (see `vscodeCodeBuddyPluginInstalled`). An ungated gate would make
 * lifeline write a debug port into `~/.vscode/argv.json` — and self-heal
 * **restart** VSCode — on every machine that merely has VSCode installed
 * (near-universal), not just the ones that opted into CodeBuddy-in-VSCode.
 */

/** macOS app name / `osascript` target. Windows image is `Code.exe` (win-paths). */
export const VSCODE_APP_NAME = 'Visual Studio Code';

/** Extension directory prefix under `~/.vscode/extensions/` (version suffix follows). */
export const CODEBUDDY_VSCODE_EXTENSION_PREFIX = 'tencent-cloud.coding-copilot';

/**
 * VSCode's extensions dir: `~/.vscode/extensions` on **all** platforms
 * (Windows: `%USERPROFILE%\.vscode\extensions`). Insiders uses
 * `~/.vscode-insiders` — deliberately out of scope.
 */
export function vscodeExtensionsDir(home: string = homedir()): string {
  return join(home, '.vscode', 'extensions');
}

export interface VscodePluginDeps {
  exists?: (p: string) => boolean;
  readdir?: (p: string) => string[];
  home?: string;
}

/**
 * Is the CodeBuddy plugin installed in VSCode? Cheap (one readdir of the
 * extensions dir); called on endpoint-candidate construction and relauncher
 * decisions. Injection points exist so unit tests never touch the real home.
 */
export function vscodeCodeBuddyPluginInstalled(deps: VscodePluginDeps = {}): boolean {
  const dir = vscodeExtensionsDir(deps.home);
  const exists = deps.exists ?? existsSync;
  if (!exists(dir))
    return false;
  const readdir = deps.readdir ?? readdirSync;
  try {
    return readdir(dir).some(name => name.startsWith(CODEBUDDY_VSCODE_EXTENSION_PREFIX));
  }
  catch {
    return false;
  }
}
