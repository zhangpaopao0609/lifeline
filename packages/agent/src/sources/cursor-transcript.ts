/**
 * Cursor writes each chat's finished turns to `~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl`
 * on its own, independent of `state.vscdb`. The database is lazy: a session's newest assistant replies can sit in it as
 * empty "stub" bubbles (no text, no thinking, no tool call — only a short `textPreview` in the header) for as long as the
 * window is idle or occluded, while the transcript already has the full text (2026-09-30: three whole turns of
 * "Integration with large models" were missing from the phone for over an hour).
 *
 * This module fills those stubs from the transcript and nothing else. It is deliberately conservative — a wrong fill
 * (a reply shown under the wrong bubble) is worse than a missing one — so it only acts when the alignment is unambiguous:
 *  - the transcript must have exactly as many user messages as the session has human bubbles, otherwise nothing is filled;
 *  - only stubs are touched, never a bubble that already has content;
 *  - a stub with a header preview takes the transcript entry that starts with that preview;
 *  - otherwise only the **last** bubble of a turn may take the **last** entry of that turn, and only when the disk has no
 *    trace of that entry (thinking blocks show up in the transcript as ordinary assistant text, so the entries before the
 *    last one cannot be told apart from replies).
 */

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface TurnBubble {
  id: string;
  role: 'human' | 'assistant';
  /** Header `grouping.textPreview` (a prefix of the eventual text). */
  preview?: string;
  /** Body facts. Absent = not read (outside the window); such a bubble is never treated as a stub. */
  body?: { text: string; thinking: string; tool: boolean };
}

/** Turns from the end that are examined; older turns are settled and their bodies are not even read. */
export const TRANSCRIPT_TAIL_TURNS = 8;

/** Human bubble text as the user typed it. Cursor wraps later turns in `<timestamp>` / `<user_query>`. */
export function humanBubbleText(raw: string): string {
  const open = raw.indexOf('<user_query>');
  if (open >= 0) {
    const from = open + '<user_query>'.length;
    const close = raw.indexOf('</user_query>', from);
    return raw.slice(from, close >= 0 ? close : undefined).trim();
  }
  return raw.replace(/<timestamp>[^<]*<\/timestamp>/g, '').trim();
}

export function parseTranscript(raw: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim())
      continue;
    let row: { role?: unknown; message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    }
    catch {
      continue; // a torn last line while Cursor is writing
    }
    if (row.role !== 'user' && row.role !== 'assistant')
      continue;
    const content = row.message?.content;
    const parts: string[] = [];
    if (typeof content === 'string') {
      parts.push(content);
    }
    else if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; text?: unknown }>) {
        if (block?.type === 'text' && typeof block.text === 'string')
          parts.push(block.text);
      }
    }
    const joined = parts.join('\n').trim();
    if (!joined)
      continue;
    out.push({ role: row.role, text: row.role === 'user' ? humanBubbleText(joined) : joined });
  }
  return out;
}

const squash = (s: string): string => s.replace(/\s+/g, '');

/** Same start, compared over the shorter of the two (a preview is a truncated prefix). */
function sameStart(a: string, b: string): boolean {
  const na = squash(a);
  const nb = squash(b);
  const n = Math.min(na.length, nb.length, 24);
  if (n < 2)
    return false;
  return na.slice(0, n) === nb.slice(0, n);
}

function isStub(b: TurnBubble): boolean {
  return b.role === 'assistant'
    && b.body !== undefined
    && b.body.text.trim() === ''
    && b.body.thinking.trim() === ''
    && !b.body.tool;
}

function isEmptyHuman(b: TurnBubble): boolean {
  return b.role === 'human' && b.body !== undefined && b.body.text.trim() === '' && !b.body.tool;
}

/** bubbleId → text to show, for stubs only. Empty map when the alignment is not provable. */
export function fillFromTranscript(
  bubbles: TurnBubble[],
  entries: TranscriptEntry[],
): Map<string, string> {
  const out = new Map<string, string>();
  const humans = bubbles.filter(b => b.role === 'human').length;
  const users = entries.filter(e => e.role === 'user').length;
  if (humans === 0 || humans !== users)
    return out;

  // Split both sides into turns keyed by the k-th human / user message.
  const bubbleTurns: TurnBubble[][] = [];
  for (const b of bubbles) {
    if (b.role === 'human')
      bubbleTurns.push([b]);
    else if (bubbleTurns.length > 0)
      bubbleTurns[bubbleTurns.length - 1].push(b);
  }
  const entryTurns: TranscriptEntry[][] = [];
  for (const e of entries) {
    if (e.role === 'user')
      entryTurns.push([e]);
    else if (entryTurns.length > 0)
      entryTurns[entryTurns.length - 1].push(e);
  }

  for (let k = Math.max(0, bubbleTurns.length - TRANSCRIPT_TAIL_TURNS); k < bubbleTurns.length; k++) {
    const [human, ...rest] = bubbleTurns[k];
    const [user, ...replies] = entryTurns[k];

    if (isEmptyHuman(human) && user.text)
      out.set(human.id, user.text);

    if (replies.length === 0 || !rest.some(isStub))
      continue;

    // Entries the disk already shows (as text or as thinking) are not candidates.
    const known = rest.flatMap(b => (b.body ? [b.body.text, b.body.thinking] : [])).filter(t => t.trim() !== '');
    const unmatched = replies.filter(r => !known.some(t => sameStart(t, r.text)));
    if (unmatched.length === 0)
      continue;

    const used = new Set<TranscriptEntry>();
    for (const b of rest) {
      if (!isStub(b) || !b.preview?.trim())
        continue;
      const hit = unmatched.find(r => !used.has(r) && sameStart(b.preview!, r.text));
      if (hit) {
        used.add(hit);
        out.set(b.id, hit.text);
      }
    }

    const last = rest[rest.length - 1];
    const lastReply = replies[replies.length - 1];
    if (isStub(last) && !out.has(last.id) && unmatched.includes(lastReply) && !used.has(lastReply))
      out.set(last.id, lastReply.text);
  }
  return out;
}
