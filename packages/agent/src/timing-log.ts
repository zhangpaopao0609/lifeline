/** One-line hop logs so a send/echo delay can be grepped from agent + server + browser. */

export function timingPreview(text: string | undefined, max = 24): string {
  if (!text)
    return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Last human/assistant bubble, for correlating a send with the disk echo. */
export function timingLastBubble(
  messages: Array<{ type?: string; text?: string } | undefined>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m.type === 'human' || m.type === 'assistant') && m.text) {
      return `${m.type}:${timingPreview(m.text)}`;
    }
  }
  return '';
}

export function timingLog(
  hop: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined)
      continue;
    bits.push(
      `${key}=${typeof value === 'string' && /[\s"]/.test(value) ? JSON.stringify(value) : String(value)}`,
    );
  }
  console.log(`[timing] ${hop}${bits.length ? ` ${bits.join(' ')}` : ''}`);
}
