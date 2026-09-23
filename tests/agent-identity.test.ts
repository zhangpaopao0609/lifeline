import type { CliConfig } from '../packages/cli/src/config.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ensureAgentId, newAgentId, resolveAgentId } from '../packages/cli/src/config.js';

function cliConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    serverUrl: 'http://127.0.0.1:3000',
    agentToken: 'token',
    cdpUrl: 'http://127.0.0.1:9222',
    pollIntervalMs: 500,
    debounceMs: 300,
    ...overrides,
  };
}

describe('cli agent id', () => {
  it('配置里的 id 优先；没有才看环境变量；再没有才生成', () => {
    assert.equal(resolveAgentId('machine-config', 'machine-env'), 'machine-config');
    assert.equal(resolveAgentId(undefined, 'machine-env'), 'machine-env');
    assert.match(resolveAgentId(undefined, undefined), /^machine-[0-9a-f-]{36}$/);
  });

  it('空串当没有（否则服务端会退回拿 socket id 当机器号）', () => {
    assert.equal(resolveAgentId('', 'machine-env'), 'machine-env');
    assert.match(resolveAgentId('', ''), /^machine-/);
  });

  it('ensureAgentId 只在缺 id 时补一个并落盘', () => {
    const saved: CliConfig[] = [];
    const kept = ensureAgentId(cliConfig({ agentId: 'machine-keep' }), c => saved.push(c));
    assert.equal(kept.agentId, 'machine-keep');
    assert.deepEqual(saved, [], '已有 id → 不写盘');

    const filled = ensureAgentId(cliConfig(), c => saved.push(c));
    assert.match(filled.agentId!, /^machine-/);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].agentId, filled.agentId, '补出来的 id 必须落盘，重启才对得上');
  });

  it('newAgentId 是随机值，不是主机名派生', () => {
    const a = newAgentId();
    const b = newAgentId();
    assert.notEqual(a, b);
    assert.match(a, /^machine-[0-9a-f-]{36}$/);
  });
});
