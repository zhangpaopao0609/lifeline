/**
 * Composer attachments that travel as **paths in the typed prompt**.
 *
 * The console (browser) cannot reach the IDE machine's disk; the agent can. So the bytes ride in the
 * `command:send_message` payload, the agent writes them next to its own config, and the prompt it
 * types gains a trailing block naming those local paths — the IDE's tools read them from there.
 *
 * Both sides need the exact same block text: the agent appends it, the console strips it back off
 * the disk echo so an optimistic bubble can be matched against its real counterpart
 * (`store/sessions.ts` `pruneResolvedPending`).
 */

/** First line of the appended block. Changing it changes what `stripAttachmentBlock` recognizes. */
export const ATTACHMENT_BLOCK_TITLE = '【附件】已保存到本机，可直接打开读取：';

const BLOCK_SEPARATOR = '\n\n';

/** `title` + one `- /abs/path` line per file. */
export function attachmentBlock(paths: string[]): string {
  return [ATTACHMENT_BLOCK_TITLE, ...paths.map(p => `- ${p}`)].join('\n');
}

/** User text + attachment paths; the text may be empty (a bare screenshot is a valid send). */
export function withAttachmentPaths(text: string, paths: string[]): string {
  const body = text.trim();
  if (paths.length === 0)
    return body;
  return body.length > 0 ? `${body}${BLOCK_SEPARATOR}${attachmentBlock(paths)}` : attachmentBlock(paths);
}

/**
 * The user's own text, with a trailing attachment block removed (anything else is untouched).
 * Only a block that starts a fresh paragraph counts: a message that merely *mentions* the title
 * inline is still the same message.
 */
export function stripAttachmentBlock(text: string): string {
  const at = text.indexOf(`${BLOCK_SEPARATOR}${ATTACHMENT_BLOCK_TITLE}`);
  if (at !== -1)
    return text.slice(0, at);
  if (text.startsWith(ATTACHMENT_BLOCK_TITLE))
    return '';
  return text;
}
