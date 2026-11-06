import type { IdeKind } from '../net/protocol';
import { IDE_KINDS } from '../net/protocol';

/** Rail label for an IDE this machine can read and cannot drive. */
export const SESSION_SOURCE_LABEL = '会话源·只读';

/**
 * Content-only machines show an IDE row only when that IDE has sessions.
 * Order follows `IDE_KINDS`, so a partial report cannot reshuffle the rail.
 */
export function sessionSourceIdes(contentIdes: readonly string[] | undefined): IdeKind[] {
  const have = new Set(contentIdes ?? []);
  return IDE_KINDS.filter(ide => have.has(ide));
}
