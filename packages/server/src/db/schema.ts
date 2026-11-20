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
  /** Manual rail position (drag sorting). null = never reordered → registration order, appended at the end. */
  sortOrder: integer('sort_order'),
});

export const machineTokens = sqliteTable('machine_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  agentId: text('agent_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
  lastUsedAt: integer('last_used_at'),
});

/** One row per registered account. user_id is the canonical username and the session userId. */
export const authAccounts = sqliteTable('auth_accounts', {
  userId: text('user_id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Single-row table for the session signing key (id is always 1). password_hash is unused. */
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

/** 用户手动建的会话分组（网页会话列）。按登录用户存，跨机器共享；归属见 `session_group_members`。 */
export const sessionGroups = sqliteTable('session_groups', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** 会话 → 分组归属。一个会话最多属于一个分组（"属于那个"），移动 = 覆盖这一行。 */
export const sessionGroupMembers = sqliteTable(
  'session_group_members',
  {
    ownerUserId: text('owner_user_id').notNull(),
    sessionId: text('session_id').notNull(),
    groupId: text('group_id').notNull(),
  },
  t => [primaryKey({ columns: [t.ownerUserId, t.sessionId] })],
);
