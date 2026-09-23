import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SOCKET_MAX_HTTP_BUFFER_SIZE,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_TIMEOUT_MS,
} from '../packages/server/src/socket-limits.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('socket.io payload limit', () => {
  it('is 20MB, not the 1MB default that drops a live Cursor session:full', () => {
    assert.equal(SOCKET_MAX_HTTP_BUFFER_SIZE, 20 * 1024 * 1024);
  });

  it('is applied on the server, the browser client, and the agent uplink', () => {
    const relay = readFileSync(join(ROOT, 'packages/server/src/relay.ts'), 'utf-8');
    const web = readFileSync(join(ROOT, 'packages/web/src/net/socket.ts'), 'utf-8');
    const uplink = readFileSync(join(ROOT, 'packages/agent/src/uplink.ts'), 'utf-8');
    assert.match(relay, /maxHttpBufferSize:\s*SOCKET_MAX_HTTP_BUFFER_SIZE/);
    assert.equal((relay.match(/maxHttpBufferSize:/g) ?? []).length, 2);
    assert.match(web, /maxHttpBufferSize:\s*20 \* 1024 \* 1024/);
    assert.match(uplink, /maxHttpBufferSize:\s*SOCKET_MAX_HTTP_BUFFER_SIZE/);
  });

  it('gives the agent uplink 120s to pong while sqlite/session:full runs', () => {
    assert.equal(SOCKET_PING_TIMEOUT_MS, 120_000);
    assert.equal(SOCKET_PING_INTERVAL_MS, 25_000);
    const relay = readFileSync(join(ROOT, 'packages/server/src/relay.ts'), 'utf-8');
    assert.match(relay, /pingTimeout:\s*SOCKET_PING_TIMEOUT_MS/);
    assert.match(relay, /pingInterval:\s*SOCKET_PING_INTERVAL_MS/);
  });
});
