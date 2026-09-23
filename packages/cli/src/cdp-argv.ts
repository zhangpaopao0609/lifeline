const MARKER = 'Lifeline CDP';
const LEGACY_MARKER = 'AgentRemote CDP';
const KEY_RE = /"remote-debugging-port"\s*:/;

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
export function ensureRemoteDebuggingPortInText(text: string, port = 9222): { text: string; changed: boolean } {
  if (hasRemoteDebuggingPort(text)) {
    return { text, changed: false };
  }
  const insert = `\t// ${MARKER}\n\t"remote-debugging-port": ${port}\n`;
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

const PORT_VALUE_RE = /("remote-debugging-port"\s*:\s*)(\d+)/;

/**
 * Rewrite a Lifeline-managed remote-debugging-port, or insert one.
 * An unmarked existing key is left untouched (`unmanaged: true`).
 */
export function setManagedRemoteDebuggingPort(
  text: string,
  port: number,
): { text: string; changed: boolean; unmanaged?: boolean } {
  if (!hasRemoteDebuggingPort(text)) {
    return ensureRemoteDebuggingPortInText(text, port);
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
  const portSame = Number(match[2]) === port;
  if (portSame && !isLegacy) {
    return { text, changed: false };
  }
  if (isLegacy) {
    lines[markerIdx] = lines[markerIdx]!.replace(LEGACY_MARKER, MARKER);
  }
  if (!portSame) {
    lines[keyIdx] = keyLine.replace(PORT_VALUE_RE, `$1${port}`);
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
