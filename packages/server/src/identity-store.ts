import type Database from 'better-sqlite3';
import type { AgentPlatform } from '../../protocol/src/index.js';
import type { LifelineDb } from './db/open.js';
import type { AgentIdesState } from './ide.js';
import type { CursorState } from './types.js';
/**
 * Identity and machine ownership (`users` / `machine_tokens` / `machines` in `data/lifeline.sqlite`).
 *
 * "Who can see which machine" = `machines.owner_user_id === the logged-in user's userId`.
 * Credentials are per-machine: plaintext is returned once at exchange; the DB stores sha256.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { toAgentPlatform } from '../../protocol/src/index.js';
import { openDrizzle } from './db/open.js';
import { machines, machineTokens, users } from './db/schema.js';
import { IDE_KINDS, wrapIncomingFull } from './ide.js';

export interface MachineRow {
  agentId: string;
  hostname: string;
  /** Console alias ("Rename"); default = show hostname. */
  displayName?: string;
  /** OS the machine self-reports (darwin / win32 / linux); default = old agent never reported it. */
  platform?: AgentPlatform;
  lastSeenAt: number;
  snapshot: AgentIdesState | CursorState | null;
  updatedAt: number;
  cliVersion?: string;
  owner?: string;
}

export interface HandshakeIdentity {
  owner: string;
  agentId: string;
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function defaultMint(): string {
  return randomBytes(24).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function stripSlot(state: CursorState | undefined): CursorState | undefined {
  if (!state)
    return undefined;
  const { _rawSignals: _ignored, ...rest } = state;
  return rest;
}

function persistSnapshot(state: AgentIdesState | CursorState | null): AgentIdesState | null {
  if (!state)
    return null;
  const wrapped = wrapIncomingFull(state);
  // Loop over IDE_KINDS (review suggestion #1): a two-named-key write would silently drop a new IDE's
  // machine snapshot on the DB persist path — same convergence as agent-hub's stripIdesState.
  const ides: AgentIdesState['ides'] = {};
  for (const ide of IDE_KINDS) {
    const slot = stripSlot(wrapped.ides[ide]);
    if (slot)
      ides[ide] = slot;
  }
  return { ides };
}

export class IdentityStore {
  private readonly sqlite: Database.Database;
  private readonly orm: LifelineDb;
  private readonly now: () => number;
  private readonly mint: () => string;

  constructor(dbPath: string, options?: { now?: () => number; mint?: () => string }) {
    const opened = openDrizzle(dbPath);
    this.sqlite = opened.sqlite;
    this.orm = opened.orm;
    this.now = options?.now ?? Date.now;
    this.mint = options?.mint ?? defaultMint;
  }

  // ---------------------------------------------------------------- users

  /** Seen this person: insert a row on first sight; afterwards only refresh last_seen_at outside the throttle window. */
  touchUser(userId: string, minIntervalMs: number = TOUCH_INTERVAL_MS): void {
    if (!userId)
      return;
    const now = this.now();
    const row = this.orm.select({ lastSeenAt: users.lastSeenAt }).from(users).where(eq(users.userId, userId)).get();
    if (!row) {
      this.orm
        .insert(users)
        .values({ userId, firstSeenAt: now, lastSeenAt: now })
        .run();
      return;
    }
    if (now - row.lastSeenAt < minIntervalMs)
      return;
    this.orm.update(users).set({ lastSeenAt: now }).where(eq(users.userId, userId)).run();
  }

  hasUser(userId: string): boolean {
    return !!this.orm.select({ userId: users.userId }).from(users).where(eq(users.userId, userId)).get();
  }

  loadUsers(): Array<{ userId: string; firstSeenAt: number; lastSeenAt: number }> {
    return this.orm
      .select()
      .from(users)
      .all()
      .map(row => ({
        userId: row.userId,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
      }));
  }

  // --------------------------------------------------------------- tokens

  /** Per-machine token: rotate (revoke previous hashes for this agent) and return plaintext once. */
  mintMachineToken(owner: string, agentId: string): string {
    const token = this.mint();
    const tokenHash = hashToken(token);
    const now = this.now();
    const apply = this.sqlite.transaction(() => {
      this.orm
        .update(machineTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(machineTokens.agentId, agentId),
            eq(machineTokens.ownerUserId, owner),
            isNull(machineTokens.revokedAt),
          ),
        )
        .run();
      this.orm
        .insert(machineTokens)
        .values({
          tokenHash,
          agentId,
          ownerUserId: owner,
          createdAt: now,
          revokedAt: null,
          lastUsedAt: null,
        })
        .run();
    });
    apply();
    return token;
  }

  ownerOfToken(token: string): string | undefined {
    return this.resolveHandshake(token)?.owner;
  }

  resolveHandshake(token: string): HandshakeIdentity | undefined {
    if (!token)
      return undefined;
    const hash = hashToken(token);
    const machine = this.orm
      .select()
      .from(machineTokens)
      .where(and(eq(machineTokens.tokenHash, hash), isNull(machineTokens.revokedAt)))
      .get();
    if (machine) {
      this.orm
        .update(machineTokens)
        .set({ lastUsedAt: this.now() })
        .where(eq(machineTokens.tokenHash, hash))
        .run();
      return { owner: machine.ownerUserId, agentId: machine.agentId };
    }
    return undefined;
  }

  // ------------------------------------------------------------- machines

  loadMachines(): MachineRow[] {
    const rows = this.orm.select().from(machines).all();
    const out: MachineRow[] = [];
    for (const row of rows) {
      let snapshot: AgentIdesState | null = null;
      if (row.snapshotJson) {
        try {
          snapshot = wrapIncomingFull(JSON.parse(row.snapshotJson));
        }
        catch {
          snapshot = null;
        }
      }
      // The column may hold historical / hand-edited strings: keep the three known values; treat unrecognized as never reported.
      const platform = toAgentPlatform(row.platform);
      out.push({
        agentId: row.agentId,
        hostname: row.hostname,
        ...(row.displayName ? { displayName: row.displayName } : {}),
        ...(platform ? { platform } : {}),
        lastSeenAt: row.lastSeenAt,
        snapshot,
        updatedAt: row.updatedAt,
        ...(row.cliVersion ? { cliVersion: row.cliVersion } : {}),
        ...(row.ownerUserId ? { owner: row.ownerUserId } : {}),
      });
    }
    return out;
  }

  /**
   * Persist the machine's live state and self-reported fields. **Does not include the alias**: `display_name`
   * only goes through `setDisplayName` — a state:patch upsert must never overwrite it (hostname is
   * self-reported and may refresh; the alias is user-chosen and must not be overwritten by the machine).
   */
  upsertMachine(row: Omit<MachineRow, 'updatedAt' | 'displayName'>): void {
    const snapshot = persistSnapshot(row.snapshot);
    this.orm
      .insert(machines)
      .values({
        agentId: row.agentId,
        ownerUserId: row.owner ?? null,
        hostname: row.hostname,
        cliVersion: row.cliVersion ?? null,
        platform: row.platform ?? null,
        lastSeenAt: row.lastSeenAt,
        updatedAt: this.now(),
        snapshotJson: snapshot ? JSON.stringify(snapshot) : null,
      })
      .onConflictDoUpdate({
        target: machines.agentId,
        set: {
          ownerUserId: sql`COALESCE(${machines.ownerUserId}, excluded.owner_user_id)`,
          hostname: sql`excluded.hostname`,
          cliVersion: sql`excluded.cli_version`,
          // Platform is a machine property, not a property of the current binary: if this report omits it (old agent),
          // keep the previous value — don't flush a useful row to NULL (cliVersion is the opposite — that is a statement about the current binary).
          platform: sql`COALESCE(excluded.platform, ${machines.platform})`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
          snapshotJson: sql`excluded.snapshot_json`,
        },
      })
      .run();
  }

  removeMachine(agentId: string): void {
    const apply = this.sqlite.transaction(() => {
      this.orm.delete(machineTokens).where(eq(machineTokens.agentId, agentId)).run();
      this.orm.delete(machines).where(eq(machines.agentId, agentId)).run();
    });
    apply();
  }

  /** Write the alias; null = clear (the page falls back to hostname). No-op if the row does not exist. */
  setDisplayName(agentId: string, displayName: string | null): void {
    this.orm
      .update(machines)
      .set({ displayName })
      .where(eq(machines.agentId, agentId))
      .run();
  }

  renameMachine(oldAgentId: string, newAgentId: string): void {
    const apply = this.sqlite.transaction(() => {
      this.orm
        .update(machines)
        .set({ agentId: newAgentId })
        .where(eq(machines.agentId, oldAgentId))
        .run();
      this.orm
        .update(machineTokens)
        .set({ agentId: newAgentId })
        .where(eq(machineTokens.agentId, oldAgentId))
        .run();
    });
    apply();
  }

  close(): void {
    this.sqlite.close();
  }
}
