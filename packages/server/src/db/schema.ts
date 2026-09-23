import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  userId: text('user_id').primaryKey(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
});

export const machines = sqliteTable('machines', {
  agentId: text('agent_id').primaryKey(),
  ownerUserId: text('owner_user_id'),
  hostname: text('hostname').notNull(),
  /** Console alias for this machine ("Rename"). null = show hostname. */
  displayName: text('display_name'),
  /** OS the machine self-reports (darwin / win32 / linux). null = old agent never reported it → the page falls back to the OS toggle. */
  platform: text('platform'),
  cliVersion: text('cli_version'),
  lastSeenAt: integer('last_seen_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  snapshotJson: text('snapshot_json'),
});

export const machineTokens = sqliteTable('machine_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  agentId: text('agent_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
  lastUsedAt: integer('last_used_at'),
});

/** Single-row table for the password provider (id is always 1); read/write via raw sqlite in auth/local-auth-store.ts. */
export const authLocal = sqliteTable('auth_local', {
  id: integer('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  sessionSecret: text('session_secret').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    agentId: text('agent_id').notNull(),
    ide: text('ide').notNull(),
    sessionId: text('session_id').notNull(),
    metaJson: text('meta_json').notNull(),
    lastUpdatedAt: integer('last_updated_at').notNull(),
  },
  t => [primaryKey({ columns: [t.agentId, t.ide, t.sessionId] })],
);

export const messages = sqliteTable(
  'messages',
  {
    agentId: text('agent_id').notNull(),
    ide: text('ide').notNull(),
    sessionId: text('session_id').notNull(),
    messageId: text('message_id').notNull(),
    flatIndex: integer('flat_index').notNull(),
    payload: text('payload').notNull(),
  },
  t => [primaryKey({ columns: [t.agentId, t.ide, t.sessionId, t.messageId] })],
);

export const sessionSeq = sqliteTable(
  'session_seq',
  {
    agentId: text('agent_id').notNull(),
    ide: text('ide').notNull(),
    sessionId: text('session_id').notNull(),
    lastSeq: integer('last_seq').notNull(),
  },
  t => [primaryKey({ columns: [t.agentId, t.ide, t.sessionId] })],
);
