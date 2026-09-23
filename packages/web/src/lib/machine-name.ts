import type { MachineInfo } from '../net/protocol';

/**
 * Display name for a machine on the page: the alias from the ⋯ menu wins; otherwise the hostname the machine reported.
 * Every "name a person sees" goes through here — don't print `hostname` directly, or a rename still leaks the old name everywhere.
 */
export function machineLabel(machine: Pick<MachineInfo, 'hostname' | 'displayName'>): string {
  return machine.displayName || machine.hostname;
}
