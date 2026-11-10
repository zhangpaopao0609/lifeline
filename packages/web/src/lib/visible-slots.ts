import type { IdeKind } from '../net/protocol';
import { IDE_KINDS } from '../net/protocol';

/** The pre-split set: the only slots an agent that reports no summary can have. */
export const LEGACY_SLOTS: readonly IdeKind[] = ['cursor', 'codebuddy'];

/**
 * Which slot rows a machine should show.
 *
 * A slot row is a **live surface**: rendering `IDE_KINDS` unconditionally put a
 * "VS Code" row on every machine — including the ones without the plugin, where
 * clicking it leads nowhere (and old agents would fold the resulting command into
 * the cursor slot). So the rail renders exactly the slots this machine reported.
 *
 * `reported` is the machine's `ides` keys (live store for the selected machine,
 * the `machines:list` summary for the rest). `fallback` covers "no summary at all"
 * (a server that predates `ides`): better two honest rows than a wrong one.
 */
export function visibleSlots(
  reported: Iterable<string> | undefined,
  fallback: readonly IdeKind[] = LEGACY_SLOTS,
): IdeKind[] {
  const present = new Set<string>(reported ?? []);
  if (present.size === 0)
    return [...fallback];
  return IDE_KINDS.filter(ide => present.has(ide));
}
