import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bootstrapDataDir, openSqlite } from '../packages/server/src/db/open.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { SessionStore } from '../packages/server/src/session-store.js';

describe('lifeline.sqlite bootstrap', () => {
  it('server bootstrap does not copy identity.sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-boot-'));
    try {
      const Database = (await import('better-sqlite3')).default;
      const idb = new Database(join(dir, 'identity.sqlite'));
      idb.exec(`
        CREATE TABLE users (
          user_id TEXT PRIMARY KEY,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
      `);
      idb.prepare('INSERT INTO users VALUES (?,?,?)').run('alice', 1, 1);
      idb.close();

      const dest = bootstrapDataDir(dir);
      const store = new IdentityStore(dest);
      assert.equal(store.hasUser('alice'), false);
      store.close();
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens a pre-ide sessions file and backfills ide=cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-ide-'));
    try {
      const Database = (await import('better-sqlite3')).default;
      const legacy = join(dir, 'legacy.sqlite');
      const db = new Database(legacy);
      db.exec(`
        CREATE TABLE sessions (
          agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
          meta_json TEXT NOT NULL, last_updated_at INTEGER NOT NULL,
          PRIMARY KEY (agent_id, session_id)
        );
      `);
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
        'agent-a',
        's1',
        JSON.stringify({
          ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 's1' },
          title: 'T',
        }),
        2,
      );
      db.close();

      const store = new SessionStore(legacy);
      assert.equal(store.readIndex('agent-a')[0]?.ref.sessionId, 's1');
      store.close();
      openSqlite(legacy).close();
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds display_name to a machines table that predates the rename feature', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-name-'));
    try {
      const Database = (await import('better-sqlite3')).default;
      const legacy = join(dir, 'legacy.sqlite');
      const db = new Database(legacy);
      // Live old DB machines table: no display_name. CREATE TABLE IF NOT EXISTS will not add the column,
      // so ALTER is required (otherwise loadMachines throws no such column on first read).
      db.exec(`
        CREATE TABLE machines (
          agent_id TEXT PRIMARY KEY,
          owner_user_id TEXT,
          hostname TEXT NOT NULL,
          cli_version TEXT,
          last_seen_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          snapshot_json TEXT
        );
      `);
      db.prepare('INSERT INTO machines VALUES (?,?,?,?,?,?,?)').run(
        'agent-a',
        'alice',
        'Mac-mini.local',
        null,
        1,
        1,
        null,
      );
      db.close();

      const store = new IdentityStore(legacy);
      assert.equal(store.loadMachines()[0]?.hostname, 'Mac-mini.local', '老行照常读出来');
      store.setDisplayName('agent-a', '客厅的 Mac mini');
      assert.equal(store.loadMachines()[0]?.displayName, '客厅的 Mac mini');
      store.close();
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds platform to a machines table that predates it, and never clobbers a known one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-platform-'));
    try {
      const Database = (await import('better-sqlite3')).default;
      const legacy = join(dir, 'legacy.sqlite');
      const db = new Database(legacy);
      // The DB version after the previous migration added display_name but not yet platform (= live shape before this change)
      db.exec(`
        CREATE TABLE machines (
          agent_id TEXT PRIMARY KEY,
          owner_user_id TEXT,
          hostname TEXT NOT NULL,
          display_name TEXT,
          cli_version TEXT,
          last_seen_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          snapshot_json TEXT
        );
      `);
      db.prepare('INSERT INTO machines VALUES (?,?,?,?,?,?,?,?)').run(
        'agent-a',
        'alice',
        'DESKTOP-1',
        null,
        null,
        1,
        1,
        null,
      );
      db.close();

      const store = new IdentityStore(legacy);
      assert.equal(store.loadMachines()[0]?.platform, undefined, '没报过的老行照常读出来，网页回落 OS 开关');
      store.upsertMachine({
        agentId: 'agent-a',
        hostname: 'DESKTOP-1',
        lastSeenAt: 2,
        snapshot: null,
        platform: 'win32',
      });
      assert.equal(store.loadMachines()[0]?.platform, 'win32');
      // An old agent reconnecting (no platform) must not overwrite a known platform with NULL: platform is a machine property
      store.upsertMachine({ agentId: 'agent-a', hostname: 'DESKTOP-1', lastSeenAt: 3, snapshot: null });
      assert.equal(store.loadMachines()[0]?.platform, 'win32');
      store.close();
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applySchema 给 sessions 建 (ide, session_id) 索引：findSessionOwners 不允许全表扫描', () => {
    // 2026-09-20 incident: without this index findSessionOwners degraded to SCAN sessions (140k rows × 35ms),
    // 30 times/sec in a storm pinned one core at 100%. The query plan must keep using the index; failing to restore it is a regression.
    const dir = mkdtempSync(join(tmpdir(), 'll-idx-'));
    try {
      const db = openSqlite(join(dir, 'lifeline.sqlite'));
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('agent-a', 'cursor', 's1', '{}', 1);
      const details = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT agent_id FROM sessions WHERE ide = ? AND session_id = ? ORDER BY last_updated_at DESC',
        )
        .all('cursor', 's1')
        .map(row => (row as { detail: string }).detail)
        .join(' | ');
      assert.match(details, /USING (COVERING )?INDEX sessions_owner/, `查询计划应走 sessions_owner：${details}`);
      db.close();
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
