const MARKER = 'Lifeline CDP';
const LEGACY_MARKER = 'AgentRemote CDP';
const KEY_RE = /"remote-debugging-port"\s*:/;

/**
 * How the port is serialized.
 *
 * `string` exists because **VSCode validates argv.json against its own schema**, where
 * `remote-debugging-port` is a string; a JSON number is dropped silently (measured
 * 2026-11-09 on VS Code 1.144: number → no `--remote-debugging-port`, no port file
 * refresh; `"0"` → the switch is applied and `DevToolsActivePort` is rewritten).
 * A dropped value is invisible — the app just starts without a port and the agent falls
 * back to quit-and-reopen, which for VSCode means killing the editor the user is in.
 *
 * Cursor / the CodeBuddy IDE keep the number form: their own argv handling was not
 * measured to accept a string, and changing it would be a different experiment.
 */
export type CdpPortValueForm = 'number' | 'string';

function formatPortValue(port: number, form: CdpPortValueForm): string {
  return form === 'string' ? `"${port}"` : String(port);
}

function isManagedMarker(text: string): boolean {
  return text.includes(MARKER) || text.includes(LEGACY_MARKER);
}

export function hasRemoteDebuggingPort(text: string): boolean {
  return KEY_RE.test(text);
}

function trimTrailingComments(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0) {
    const line = lines[lines.length - 1]!.trim();
    if (line === '' || line.startsWith('//')) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').trimEnd();
}

/** Insert remote-debugging-port without stripping existing JSONC comments. */
export function ensureRemoteDebuggingPortInText(
  text: string,
  port = 9222,
  form: CdpPortValueForm = 'number',
): { text: string; changed: boolean } {
  if (hasRemoteDebuggingPort(text)) {
    return { text, changed: false };
  }
  const insert = `\t// ${MARKER}\n\t"remote-debugging-port": ${formatPortValue(port, form)}\n`;
  const closeIdx = text.lastIndexOf('}');
  if (closeIdx === -1) {
    return { text: `{\n${insert}}\n`, changed: true };
  }
  const before = text.slice(0, closeIdx);
  const stripped = trimTrailingComments(before);
  const needsComma = !stripped.endsWith('{') && !stripped.endsWith(',');
  const prefix = needsComma ? `${stripped},` : stripped;
  return { text: `${prefix}\n${insert}}\n`, changed: true };
}

/** Both forms: the released CLI wrote a number, VSCode needs a string — a rewrite must match either. */
const PORT_VALUE_RE = /("remote-debugging-port"\s*:\s*)("?)(\d+)\2/;

/**
 * Rewrite a Lifeline-managed remote-debugging-port, or insert one.
 * An unmarked existing key is left untouched (`unmanaged: true`).
 */
export function setManagedRemoteDebuggingPort(
  text: string,
  port: number,
  form: CdpPortValueForm = 'number',
): { text: string; changed: boolean; unmanaged?: boolean } {
  if (!hasRemoteDebuggingPort(text)) {
    return ensureRemoteDebuggingPortInText(text, port, form);
  }
  if (!isManagedMarker(text)) {
    return { text, changed: false, unmanaged: true };
  }

  const lines = text.split('\n');
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(MARKER) || lines[i]!.includes(LEGACY_MARKER)) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx === -1) {
    return { text, changed: false, unmanaged: true };
  }

  let keyIdx = -1;
  for (let i = markerIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '')
      continue;
    if (KEY_RE.test(lines[i]!))
      keyIdx = i;
    break;
  }
  if (keyIdx === -1) {
    return { text, changed: false, unmanaged: true };
  }

  const keyLine = lines[keyIdx]!;
  const match = keyLine.match(PORT_VALUE_RE);
  if (!match) {
    return { text, changed: false, unmanaged: true };
  }
  const isLegacy = lines[markerIdx]!.includes(LEGACY_MARKER);
  const portSame = Number(match[3]) === port;
  // Form mismatch counts as a change: an existing `"remote-debugging-port": 0` in
  // ~/.vscode/argv.json (written by every release before this fix) is exactly the
  // broken state, and the next `lifeline start` must repair it in place.
  const formSame = (match[2] === '"') === (form === 'string');
  if (portSame && formSame && !isLegacy) {
    return { text, changed: false };
  }
  if (isLegacy) {
    lines[markerIdx] = lines[markerIdx]!.replace(LEGACY_MARKER, MARKER);
  }
  if (!portSame || !formSame) {
    lines[keyIdx] = keyLine.replace(PORT_VALUE_RE, `$1${formatPortValue(port, form)}`);
  }
  return { text: lines.join('\n'), changed: true };
}

export function removeManagedRemoteDebuggingPort(text: string): { text: string; changed: boolean } {
  if (!hasRemoteDebuggingPort(text) && !text.includes(MARKER)) {
    return { text, changed: false };
  }
  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;
  for (const line of lines) {
    if (line.includes(MARKER) || KEY_RE.test(line)) {
      changed = true;
      continue;
    }
    out.push(line);
  }
  let joined = out.join('\n');
  joined = joined.replace(/,(\s*\})/g, '$1');
  if (!joined.endsWith('\n'))
    joined += '\n';
  return { text: joined, changed };
}
