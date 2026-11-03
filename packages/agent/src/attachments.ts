import type { MessageAttachment } from '../../protocol/src/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from '../../protocol/src/index.js';

/**
 * Composer attachments: the console sends file bytes inside `command:send_message` (base64), and the
 * agent — the only side that can touch the IDE machine's disk — writes them out.
 *
 * Writing is unconditional, because the bytes must land somewhere the IDE can read either way:
 * `attach-files.ts` first tries the IDE's own paste pipeline (a chip / multimodal part), and when
 * that is refused the router types these paths into the prompt (the `@file` contract the IDE already
 * understands). Both routes need the file on disk, so neither is a special case here.
 */

/** Override for the drop directory (tests, or a machine whose home is read-only). */
export const UPLOAD_DIR_ENV = 'LIFELINE_UPLOAD_DIR';

/** Byte → MB, in one place: the limits live in `protocol/limits.ts`, the copy shown to the user is here. */
const BYTES_PER_MB = 1024 * 1024;

/** `Math.round(limit / BYTES_PER_MB)` — the number the console shows in a toast must match this message. */
function megabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/** `~/.lifeline/uploads` — sibling of the CLI's `config.json`, so it is a path the user can find. */
export function defaultUploadDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env[UPLOAD_DIR_ENV];
  return override && override.trim().length > 0 ? resolve(override) : resolve(home, '.lifeline', 'uploads');
}

/**
 * A file name that is safe on every platform the agent runs on: no separators (a crafted name must
 * not steer the write out of the upload dir), no quotes/control characters, Chinese kept as-is.
 * The tail is what matters (`-80` keeps the extension when the name is long).
 */
export function safeAttachmentName(raw: string, fallback = 'file'): string {
  const base = basename(String(raw ?? '').replace(/\\/g, '/')).trim();
  const cleaned = base
    .replace(/[^\w.\-\u4E00-\u9FA5]/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** base64 → bytes. Accepts a stray `data:` prefix so a mis-serialized caller still works. */
export function decodeAttachmentData(data: string): Buffer {
  const body = String(data ?? '').replace(/^data:[^,]*,/, '');
  if (body.length === 0)
    throw new Error('附件内容为空');
  return Buffer.from(body, 'base64');
}

export interface MaterializedAttachment {
  /** Original name (what the bubble showed / the user recognizes). */
  name: string;
  /** Absolute path on this machine — this is what goes into the prompt. */
  path: string;
  /** Decoded bytes (kept in memory for the native-paste path). */
  bytes: Buffer;
}

/** `20261102T153000` — files sort chronologically and a re-send never overwrites the previous copy. */
function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

/**
 * Write every attachment under `dir` and return the local paths. Throws (→ command fails with the
 * message shown in the console) on a limit violation or an unwritable directory: a prompt that
 * silently references files that are not there is worse than a failed send.
 */
export function materializeAttachments(
  attachments: MessageAttachment[],
  dir: string,
  now: number = Date.now(),
): MaterializedAttachment[] {
  if (attachments.length === 0)
    return [];
  if (attachments.length > MAX_ATTACHMENTS)
    throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);

  const decoded = attachments.map((a) => {
    const bytes = decodeAttachmentData(a.data);
    if (bytes.length === 0)
      throw new Error(`附件为空：${a.name}`);
    if (bytes.length > MAX_ATTACHMENT_BYTES)
      throw new Error(`附件超过 ${megabytes(MAX_ATTACHMENT_BYTES)}MB：${a.name}`);
    return { name: a.name, bytes };
  });
  const total = decoded.reduce((sum, d) => sum + d.bytes.length, 0);
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES)
    throw new Error(`附件总大小超过 ${megabytes(MAX_ATTACHMENTS_TOTAL_BYTES)}MB`);

  // The console shows this message in a red bubble and nothing else: on a remote machine it is the
  // only window into why the write failed. Wrap the errno with the step and the path — "EACCES" alone
  // does not say whether the directory or one particular file was refused.
  try {
    mkdirSync(dir, { recursive: true });
  }
  catch (err) {
    throw new Error(`附件目录不可写：${dir}（${errText(err)}）`);
  }
  const stamp = stampOf(now);
  return decoded.map((d, i) => {
    const path = join(dir, `${stamp}-${i + 1}-${safeAttachmentName(d.name)}`);
    try {
      writeFileSync(path, d.bytes, { mode: 0o600 });
    }
    catch (err) {
      throw new Error(`写入附件失败：${path}（${errText(err)}）`);
    }
    // The bytes ride along so the native-paste path does not have to read the file back.
    return { name: d.name, path, bytes: d.bytes };
  });
}

/** `err.message`, kept short: it ends up inside a toast-sized string. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Total decoded size — decides whether the paste route is still a sane CDP payload. */
export function totalAttachmentBytes(items: MaterializedAttachment[]): number {
  return items.reduce((sum, item) => sum + item.bytes.length, 0);
}
