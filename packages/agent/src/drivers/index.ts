import type { IdeKind } from '../types.js';
import type { IdeDriver } from './types.js';
import { IDE_KINDS } from '../../../protocol/src/index.js';
import { codebuddyDriver } from './codebuddy/driver.js';
import { cursorDriver } from './cursor/driver.js';

/**
 * IDE driver registry (P3). Adding an IDE = new `drivers/<kind>.ts` + an IDE_KINDS
 * entry + a registration here; existing files (ide-slot / index / live-ides /
 * window-monitor) no longer branch on kind.
 * Missing entries are rejected in createIdeSlot (added to IDE_KINDS at compile
 * time but forgot to register → the first runtime use blows up).
 */
export const DRIVERS: Partial<Record<IdeKind, IdeDriver>> = {
  cursor: cursorDriver,
  codebuddy: codebuddyDriver,
};

/** Drivers in IDE_KINDS order (unregistered entries show up as undefined). */
export function registeredDrivers(): Array<{ kind: IdeKind; driver: IdeDriver }> {
  const out: Array<{ kind: IdeKind; driver: IdeDriver }> = [];
  for (const kind of IDE_KINDS) {
    const driver = DRIVERS[kind];
    if (driver)
      out.push({ kind, driver });
  }
  return out;
}
