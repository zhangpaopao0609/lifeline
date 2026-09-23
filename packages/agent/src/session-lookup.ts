/** Resolve a session from an explicit id, or a unique open-tab title. */

export function resolveSessionId(
  sessions: Array<{ isSubagent?: boolean; title?: string; ref?: { sessionId?: string } }>,
  query: { sessionId?: string; tabTitle?: string },
): string | null {
  if (query.sessionId)
    return query.sessionId;
  const title = (query.tabTitle || '').trim();
  if (!title)
    return null;
  const matches = sessions.filter(s => !s.isSubagent && (s.title || '').trim() === title);
  if (matches.length !== 1)
    return null;
  return matches[0].ref?.sessionId || null;
}
