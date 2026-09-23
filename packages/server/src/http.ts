import type { FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  // `.ps1` is **text**: install.ps1 is decoded as text and executed by `irm ... | iex`.
  // Leaving it out would fall through to octet-stream below (no charset) → 5.1 decodes as Latin-1 →
  // non-ASCII in the script garbles. install.ps1's body is currently ASCII, but this line is the correct
  // "text assets should be served as text" answer.
  '.ps1': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.xz': 'application/x-xz',
};

/** Serve a file under `root` for `urlPath` (no `..` escape). Returns false if missing. */
export function trySendFile(reply: FastifyReply, root: string, urlPath: string): boolean {
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel || rel.includes('\0'))
    return false;
  const full = resolve(root, rel);
  const rootFull = resolve(root);
  if (full !== rootFull && !full.startsWith(rootFull + sep))
    return false;
  if (!existsSync(full))
    return false;
  let st;
  try {
    st = statSync(full);
  }
  catch {
    return false;
  }
  if (!st.isFile())
    return false;
  const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
  reply.header('Content-Type', type);
  reply.header('Cache-Control', 'no-cache, must-revalidate');
  void reply.send(createReadStream(full));
  return true;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function machineRoom(agentId: string): string {
  return `machine:${agentId}`;
}
