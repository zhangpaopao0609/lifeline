import type { IdeHost, IdeKind } from '../net/protocol';
import { IDE_LABELS } from '../net/protocol';

/**
 * Slot label for the rail row and the header line.
 *
 * Since slots are hosts, the label already names the app to open (`VS Code`); the
 * pre-split suffix ("· VS Code 插件") is only kept for labels that do not
 * mention it, so no row reads "VS Code · VS Code 插件".
 * `host` absent = unknown (old agent / never connected) → plain name, never a guess.
 */
export function ideTitle(ide: IdeKind, host?: IdeHost): string {
  if (!isPluginHost(ide, host) || IDE_LABELS[ide].includes('VS Code'))
    return IDE_LABELS[ide];
  return `${IDE_LABELS[ide]} · VS Code 插件`;
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
 * Is this slot's app **VS Code**?
 *
 * Two ways to answer, both needed for one release:
 *  - `ide === 'vscode'` — the split slot is the host, so its label already says
 *    "VS Code" and the argv hint applies;
 *  - `codebuddy` + `host === 'vscode'` — an agent that has not updated yet still
 *    merges the plugin host into the codebuddy slot, and that row must keep saying
 *    "VS Code · 插件" (otherwise the disconnected hint tells a VSCode user that a
 *    manual reopen is pointless, which is backwards).
 *
 * `cursor` + `host === 'vscode'` is a wire bug, not a label (the probe classifies
 * VSCode as foreign to cursor), so it must not change Cursor's copy.
 */
export function isPluginHost(ide: IdeKind, host?: IdeHost): boolean {
  if (ide === 'vscode')
    return true;
  return ide === 'codebuddy' && host === 'vscode';
}
