import type { IdeKind } from '../types.js';
import type { IdeDriver } from './types.js';
import { IDE_KINDS } from '../../../protocol/src/index.js';
import { codebuddyDriver } from './codebuddy/driver.js';
import { cursorDriver } from './cursor/driver.js';
import { vscodeDriver } from './vscode/driver.js';

/**
 * Host driver registry (P3 → slot = host). Adding a slot = new `drivers/<slot>.ts`
 * + an IDE_KINDS entry + a registration here; ide-slot / index / live-ides /
 * window-monitor do not branch on kind.
 *
 * Missing entries are rejected in createIdeSlot (added to IDE_KINDS at compile
 * time but forgot to register → the first runtime use blows up).
 *
 * `isEnabled` (optional, see `drivers/types.ts`) filters a driver out entirely on
 * machines where its host/surface is absent — the `vscode` slot uses it so
 * plugin-less machines see zero change.
 */
export const DRIVERS: Partial<Record<IdeKind, IdeDriver>> = {
  cursor: cursorDriver,
  codebuddy: codebuddyDriver,
  vscode: vscodeDriver,
};

/**
 * Surface registry (agent-internal; **not on the wire this phase**).
 *
 * A surface is "a chat face inside a slot", not a plugin: `cursor-composer` is the
 * editor's built-in composer (no install gate, cannot be opened twice in one
 * window), `coding-copilot` is the extension that runs in two different hosts.
 *
 * Why it exists now even though only one surface per slot is live: it is the
 * dimension that a second chat product will be added on (a new `SurfaceDef` +
 * binding, host layer untouched). Stage B turns this into the full
 * `SurfaceDef` / `SurfaceBinding` split described in the design doc, §2.2.
 */
export const SURFACES = {
  'cursor-composer': { kind: 'builtin', label: 'Cursor', hosts: ['cursor'] },
  'coding-copilot': { kind: 'extension', label: 'CodeBuddy', extensionId: 'tencent-cloud.coding-copilot', hosts: ['codebuddy', 'vscode'] },
} as const;

export type SurfaceId = keyof typeof SURFACES;

/** Which surface each slot hosts **today** (one per slot; Stage B makes it a set). */
export const SURFACE_OF: Record<IdeKind, SurfaceId> = {
  cursor: 'cursor-composer',
  codebuddy: 'coding-copilot',
  vscode: 'coding-copilot',
};

/**
 * Apply the `isEnabled` existence gate (see `drivers/types.ts`): a driver that
 * answers false is left out entirely — no slot, no disk adapter, nothing on the
 * wire. Pure so tests can drive it with stub drivers.
 */
export function enabledDrivers(
  entries: Array<{ kind: IdeKind; driver: IdeDriver }>,
): Array<{ kind: IdeKind; driver: IdeDriver }> {
  return entries.filter(({ driver }) => driver.isEnabled?.() !== false);
}

/** Every registered driver in IDE_KINDS order, ungated. */
function allDrivers(): Array<{ kind: IdeKind; driver: IdeDriver }> {
  const out: Array<{ kind: IdeKind; driver: IdeDriver }> = [];
  for (const kind of IDE_KINDS) {
    const driver = DRIVERS[kind];
    if (driver)
      out.push({ kind, driver });
  }
  return out;
}

/**
 * Slots this process should **create** (CDP + state + commands): the `isEnabled`
 * existence gate applies.
 */
export function registeredDrivers(): Array<{ kind: IdeKind; driver: IdeDriver }> {
  return enabledDrivers(allDrivers());
}

/**
 * Slots this process should **read sessions for**: content and control are two
 * gates. A slot with a disk shard keeps its adapter even when its host is not
 * controllable/installed here (restored data dir, plugin removed, content-only
 * machine) — otherwise `session:get` has no runtime to answer with. The inverse
 * never happens: a slot the console shows as live always came from `registeredDrivers()`.
 */
export function contentDrivers(): Array<{ kind: IdeKind; driver: IdeDriver }> {
  return allDrivers().filter(({ driver }) => readSessionsForThisSlot(driver));
}

/** The content-side predicate on its own (pure, so tests can drive it with stubs). */
export function readSessionsForThisSlot(driver: IdeDriver): boolean {
  return driver.isEnabled?.() !== false || driver.hasContent?.() === true;
}
