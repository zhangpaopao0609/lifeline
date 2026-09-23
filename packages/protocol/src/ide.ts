import type { CursorState, IdeKind } from './wire.js';
import { emptyCursorState } from './empty.js';
import { IDE_KINDS } from './wire.js';

export interface AgentIdesState {
  ides: Partial<Record<IdeKind, CursorState>>;
}

/**
 * Normalization (the sole implementation, P2 convergence point): unknown values fall back to 'cursor'.
 * This is the "lenient" semantics (wire-layer payloads that don't match are treated as cursor);
 * for strict checks (unknown → null) use isIdeKind — URL params and the like decide for themselves.
 */
export function parseIde(raw: unknown): IdeKind {
  return IDE_KINDS.find(k => k === raw) ?? 'cursor';
}

export function isIdeKind(raw: unknown): raw is IdeKind {
  return IDE_KINDS.includes(raw as IdeKind);
}

/** Console display name (shared label source of truth for machine rows / ⌘K / top bar, etc.). */
export const IDE_LABELS: Record<IdeKind, string> = {
  cursor: 'Cursor',
  codebuddy: 'CodeBuddy',
};

export function emptyIdesState(): AgentIdesState {
  return { ides: {} };
}

export function wrapIncomingFull(payload: unknown): AgentIdesState {
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if ('ides' in rec && rec.ides && typeof rec.ides === 'object') {
      return { ides: rec.ides as AgentIdesState['ides'] };
    }
    if ('agentStatus' in rec) {
      return { ides: { cursor: payload as CursorState } };
    }
  }
  return emptyIdesState();
}

export function applyIdePatch(
  prev: AgentIdesState,
  ide: IdeKind,
  patch: Partial<CursorState>,
): AgentIdesState {
  const current = prev.ides[ide] ?? emptyCursorState();
  return {
    ides: {
      ...prev.ides,
      [ide]: { ...current, ...patch },
    },
  };
}
