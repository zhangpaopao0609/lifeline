import type { CursorState, IdeKind } from './wire.js';
import { emptyCursorState } from './empty.js';
import { IDE_KINDS } from './wire.js';

export interface AgentIdesState {
  ides: Partial<Record<IdeKind, CursorState>>;
}

/**
 * Patch sequencing (2026-09-30). `state:patch` is an incremental diff: the agent only sends a field when
 * its value changes, so ONE lost patch leaves that field wrong on the server until the next reconnect
 * (observed: a stuck window-level `agentStatus: 'generating'` for 8+ minutes while every tab row said idle).
 * Each patch carries a per-IDE monotonic `seq`, and `epoch` (per agent process) makes a restart's seq
 * reset detectable. `state:full` carries the baseline so the server can check the very first patch too.
 * All fields are optional on the wire: an old agent omits them and the server keeps the old behavior.
 */
export interface PatchSeqBaseline {
  epoch: string;
  /** Last seq already reflected in this full state, per IDE (absent = no patch sent yet for that IDE). */
  seqs: Partial<Record<IdeKind, number>>;
}

/** Agent → server `state:patch` payload. `seq`/`epoch` are optional for old agents. */
export interface AgentPatchPayload {
  ide: IdeKind;
  patch: Partial<CursorState>;
  seq?: number;
  epoch?: string;
}

/** Reason attached to a server-initiated `agent:sync` when the server detected a patch gap. */
export const SYNC_REASON_PATCH_GAP = 'patch-gap';

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
  vscode: 'VS Code',
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
