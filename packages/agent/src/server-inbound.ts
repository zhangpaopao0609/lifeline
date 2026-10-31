import type { InboundResult } from '@lifeline/protocol';
import { assertCliCatalog, assertCliStart, cliSyncSchema, commandPayloadSchema, validateInbound } from '@lifeline/protocol';

export interface ServerCommandTarget {
  start: (payload: unknown) => void;
  sync: () => void;
  /** IDE routing stays outside this helper. A rejected command must not reach it. */
  parseIde: (ide: unknown) => void;
}

/** Schema gate for a server → agent command or `cli:sync`. Failure is closed. */
export function readServerCommand(event: string, payload: unknown): InboundResult<unknown> {
  if (event === 'cli:sync')
    return validateInbound(cliSyncSchema, payload, 'fail-closed');
  if (!event.startsWith('command:'))
    return { ok: false, code: 'fail-closed' };
  const parsed = validateInbound(commandPayloadSchema, payload, 'fail-closed');
  if (!parsed.ok)
    return parsed;
  if (event === 'command:cli_start' || event === 'command:cli_catalog') {
    try {
      if (event === 'command:cli_catalog')
        assertCliCatalog(parsed.data);
      else
        assertCliStart(parsed.data);
    }
    catch {
      return { ok: false, code: 'fail-closed' };
    }
  }
  return parsed;
}

/**
 * Accept a server command before any session manager or IDE dispatch.
 * `cli:sync` with no fields calls `sync`. A relative `cli_start` cwd calls nothing.
 */
export function deliverServerCommand(event: string, payload: unknown, target: ServerCommandTarget): void {
  const read = readServerCommand(event, payload);
  if (!read.ok)
    return;
  if (event === 'cli:sync') {
    target.sync();
    return;
  }
  if (event === 'command:cli_start')
    target.start(read.data);
}
