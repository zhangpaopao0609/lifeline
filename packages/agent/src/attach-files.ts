/**
 * Native attachments: hand the file to the IDE's own composer instead of typing a path.
 *
 * The console can only ship bytes; the IDE's real attachment pipeline is a **paste**. Dispatching a
 * `paste` event that carries `File` objects is what a user does with ⌘V, so both IDEs (VS Code forks)
 * take it through their normal handler — measured on CodeBuddy: an image lands as a Slate
 * `data-contentblock` image part, a text/JSON file lands as an `@`-file mention chip. Either way the
 * message goes out looking exactly like one composed in the IDE.
 *
 * Everything here is best-effort: if the composer is not where we expect, or the IDE ignores the
 * paste, the caller falls back to typing the local paths (`protocol/src/attachments.ts`), which is
 * what shipped before. Never let a nicer bubble cost a delivered message.
 */

export interface PasteFile {
  name: string;
  /** MIME type derived from the name; the IDE picks its handler from this. */
  mime: string;
  /** base64 body (no `data:` prefix). */
  base64: string;
}

/**
 * Above this, the base64 expression stops being a sensible CDP payload (a single evaluate would
 * carry >10MB of JS); those sends keep the path-text route.
 */
export const NATIVE_ATTACH_MAX_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  log: 'text/plain',
  zip: 'application/zip',
};

/**
 * Chat composers, in the order the drivers look for them: CodeBuddy's chat is a Slate editor inside
 * `#active-frame` (`chat-input-module_container`), Cursor's is the aislash/composer-bar input.
 */
const COMPOSER_SELECTORS = [
  '[class*="chat-input-module_container"] [data-slate-editor="true"]',
  '.aislash-editor-input',
  '.composer-bar [contenteditable="true"]',
  '#workbench\\.parts\\.auxiliarybar [contenteditable="true"]',
  '[data-slate-editor="true"]',
];

export function mimeOfFile(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Whether the IDE is likely to show this as an image (multimodal) rather than a file chip. */
export function isImageFile(name: string, mime: string = mimeOfFile(name)): boolean {
  return mime.startsWith('image/');
}

/**
 * In-page script: find the composer, paste the files into it, and report whether the IDE took them.
 *
 * "Took them" = the composer **grew an attachment node**. Deliberately not `preventDefault`-based:
 * an editor that swallows a paste it cannot keep would otherwise count as success, and the send would
 * go out with neither the image nor the path.
 */
export function pasteAttachmentsExpression(files: PasteFile[]): string {
  const specs = files.map(f => ({ name: f.name, mime: f.mime, data: f.base64 }));
  return `(async () => {
  const specs = ${JSON.stringify(specs)};
  const SELECTORS = ${JSON.stringify(COMPOSER_SELECTORS)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  // CodeBuddy renders its chat inside #active-frame (same shell the driver's fiber scripts read).
  const roots = [];
  try {
    const shell = document.getElementById('active-frame');
    const cd = shell && shell.contentDocument;
    if (cd && cd.body) roots.push(cd);
  } catch (e) { /* cross-origin shell: fall through to this document */ }
  roots.push(document);

  // The panel mounts a beat after the window is raised: poll instead of sampling once.
  const findComposer = () => {
    for (const root of roots) {
      for (const sel of SELECTORS) {
        const hit = [...root.querySelectorAll(sel)].find(visible);
        if (hit) return hit;
      }
    }
    return null;
  };
  let el = findComposer();
  for (let i = 0; !el && i < 15; i++) {
    await sleep(200);
    el = findComposer();
  }
  if (!el) return { ok: false, error: 'composer not found' };
  const boxOf = () => el.closest('form, .composer-bar, [class*="chat-input-module"], [class*="composer"]') || el.parentElement || document.body;
  // CodeBuddy keeps a pasted image as a Slate inline void node carrying
  // data-contentblock='{"type":"image",...}' — no <img>, so count those too; an editor that renders a
  // thumbnail or a file chip is covered by the other selectors.
  const countAttachments = () => boxOf().querySelectorAll(
    '[data-contentblock], img, [class*="attachment"], [class*="image-thumb"], [data-testid*="attachment"], [data-testid*="image"]',
  ).length;
  const before = countAttachments();
  const dt = new DataTransfer();
  for (const s of specs) {
    const bytes = Uint8Array.from(atob(s.data), c => c.charCodeAt(0));
    dt.items.add(new File([bytes], s.name, { type: s.mime }));
  }
  el.focus();
  const notCancelled = el.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  }));
  // A thumbnail can land a beat later, so sample twice. Success **requires** a visible change:
  // preventDefault alone is not proof (an editor may swallow a paste it does not keep), and we would
  // rather type the paths than send a message that silently lost its file.
  await sleep(700);
  let after = countAttachments();
  if (after <= before) {
    await sleep(900);
    after = countAttachments();
  }
  // All or nothing: one chip for four files would mean three files the model never sees, and the
  // caller only writes path text when this says no. Partial replies carry the count for the log.
  const added = after - before;
  const ok = added >= specs.length;
  return {
    ok,
    added,
    before,
    after,
    handled: notCancelled === false,
    ...(ok ? {} : { error: added > 0 ? 'composer took ' + added + '/' + specs.length : 'composer kept nothing' }),
    // Diagnostic payload: what the composer looks like when a paste is refused (grep the agent log).
    // Image bodies are stripped — they are megabytes of base64 and add nothing to the diagnosis.
    html: boxOf().outerHTML
      .replace(/data-contentblock="[^"]{200,}"/g, 'data-contentblock="…"')
      .slice(0, 900),
  };
})()`;
}

export interface PasteAttachOutcome {
  ok: boolean;
  error?: string;
  attached?: number;
}

/** Interpret the script's JSON reply (CDP gives us `unknown`). */
export function interpretPasteAttach(value: unknown): PasteAttachOutcome {
  if (!value || typeof value !== 'object')
    return { ok: false, error: 'no reply from composer' };
  const v = value as { ok?: boolean; error?: string; added?: number; before?: number; after?: number };
  // Older scripts only reported the absolute count: fall back to after − before.
  const added = typeof v.added === 'number'
    ? v.added
    : (typeof v.after === 'number' && typeof v.before === 'number' ? v.after - v.before : undefined);
  if (v.ok === true)
    return { ok: true, attached: added };
  return {
    ok: false,
    ...(added !== undefined && added > 0 ? { attached: added } : {}),
    error: v.error ?? 'composer refused the paste',
  };
}
