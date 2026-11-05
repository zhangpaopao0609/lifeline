import type { IdeHost, IdeKind } from '../net/protocol';
import { IDE_LABELS } from '../net/protocol';

/**
 * Slot label for the rail row and the header line.
 *
 * The standalone IDE adds nothing — the product name already is the truth. The
 * plugin host **is** named: on a plugin-only machine, "CodeBuddy" alone tells the
 * user to open an app that is not installed (the thing to open is VS Code).
 * `host` absent = unknown (old agent / never connected) → plain name, never a guess.
 */
export function ideTitle(ide: IdeKind, host?: IdeHost): string {
  return isPluginHost(ide, host) ? `${IDE_LABELS[ide]} · VS Code 插件` : IDE_LABELS[ide];
}

/**
 * What the status sentences talk about ("X 没在运行，打开它即可" / "正在尝试自动重启 X").
 *
 * For the VSCode host that is **VS Code itself**: it is the process we quit and
 * reopen, so the sentence must not name CodeBuddy (the standalone IDE would be
 * the wrong app to look at, and the wrong thing to blame for unsaved work).
 */
export function ideSubject(ide: IdeKind, host?: IdeHost): string {
  return isPluginHost(ide, host) ? 'VS Code' : IDE_LABELS[ide];
}

/**
 * Only the `codebuddy` slot has a plugin host; any other combination is a wire
 * bug, not a label. Exported for copy that has to branch on the host (the
 * disconnected hint: VSCode honours `argv.json`, Cursor and the CodeBuddy IDE do not).
 */
export function isPluginHost(ide: IdeKind, host?: IdeHost): boolean {
  return ide === 'codebuddy' && host === 'vscode';
}
