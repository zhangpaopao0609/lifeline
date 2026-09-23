import type { ManagerOptions, Socket, SocketOptions } from 'socket.io-client';
import type { CommandEvent, CommandPayload, CommandResult } from './protocol';
import { io } from 'socket.io-client';

/**
 * Socket singleton + command reconciliation.
 *
 * Production builds connect to the current origin (same origin as the server). `pnpm run dev` sets
 * VITE_RELAY_URL at production; only the frontend hot-reloads — no local relay, and ~/.lifeline daemons are untouched.
 */
const relayUrl = import.meta.env.VITE_RELAY_URL;

export const socket: Socket = io(relayUrl || undefined, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  withCredentials: true,
  maxHttpBufferSize: 20 * 1024 * 1024,
} as Partial<ManagerOptions & SocketOptions>);

export function newCommandId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Send a command (auto-fills commandId); results go through bind.ts's global command:result reconciliation. */
export function sendCommand(
  event: CommandEvent,
  payload: Omit<CommandPayload, 'commandId'> & { commandId?: string },
): string {
  const commandId = payload.commandId ?? newCommandId();
  socket.emit(event, { ...payload, commandId });
  return commandId;
}

export class CommandTimeoutError extends Error {
  constructor(public readonly commandId: string) {
    super(`Command timed out: ${commandId}`);
    this.name = 'CommandTimeoutError';
  }
}

const awaiters = new Map<string, (result: CommandResult) => void>();

/** command:result reconciliation entry (bind.ts calls this first when a result arrives). */
export function resolveAwaitedCommand(result: CommandResult): boolean {
  const resolve = awaiters.get(result.commandId);
  if (!resolve)
    return false;
  awaiters.delete(result.commandId);
  resolve(result);
  return true;
}

/** Send a command and wait for command:result (get_plan_full / get_model_options and other cases that need the reply payload). */
export function sendCommandAwaitResult(
  event: CommandEvent,
  payload: Omit<CommandPayload, 'commandId'>,
  timeoutMs = 20_000,
): Promise<CommandResult> {
  const commandId = newCommandId();
  return new Promise<CommandResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      awaiters.delete(commandId);
      reject(new CommandTimeoutError(commandId));
    }, timeoutMs);
    awaiters.set(commandId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    socket.emit(event, { ...payload, commandId });
  });
}
