import type { CliAcpCapability } from '@lifeline/protocol';
import type { Socket } from 'socket.io-client';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { staticCliAcp } from '../packages/agent/src/cli-capability.js';
import { Uplink } from '../packages/agent/src/uplink.js';

/**
 * 假 socket：只实现 Uplink 用到的面。fire() 模拟服务端事件；
 * disconnect/removeAllListeners 记录调用，供断言 rebuild 的拆除序列。
 */
class FakeSocket {
  handlers = new Map<string, Array<(payload?: unknown) => void>>();
  anyHandlers: Array<(event: string, ...args: unknown[]) => void> = [];
  sent: Array<{ event: string; payload: unknown }> = [];
  disconnectCalls = 0;
  removeAllListenersCalls = 0;
  connected = false;

  on(event: string, fn: (payload?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  onAny(fn: (event: string, ...args: unknown[]) => void): this {
    this.anyHandlers.push(fn);
    return this;
  }

  emit(event: string, payload: unknown): this {
    this.sent.push({ event, payload });
    return this;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    this.handlers.clear();
    this.anyHandlers = [];
    return this;
  }

  disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  fire(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) {
      fn(...(args as []));
    }
    for (const fn of this.anyHandlers) {
      fn(event, ...args);
    }
  }
}

function makeUplink(thresholdMs = 25, instanceId?: string, cliAcp?: CliAcpCapability) {
  const sockets: FakeSocket[] = [];
  const uplink = new Uplink('http://server.test', 'token-1', 'machine-x', ['cursor'], false, {
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(cliAcp !== undefined ? { cliAcp } : {}),
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      // 重建出的 socket 在下一 tick 自动 connect（handler 在构造/rebuild 里同步
      // 挂好后才轮到它）：模拟"服务端可用"，watchdog 应就此 disarm，不再连环重建。
      if (sockets.length > 1)
        setTimeout(() => s.fire('connect'), 0);
      return s as unknown as Socket;
    },
    watchdogThresholdMs: thresholdMs,
    watchdogMaxThresholdMs: thresholdMs * 4,
  });
  return { uplink, sockets };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Uplink watchdog rebuild', () => {
  it('connect 后发 agent:register 并转发 connected；send 走当前 socket', async () => {
    const { uplink, sockets } = makeUplink();
    let connectedCount = 0;
    uplink.on('connected', () => connectedCount++);

    sockets[0].fire('connect');
    assert.equal(connectedCount, 1);
    const register = sockets[0].sent.find(s => s.event === 'agent:register');
    assert.ok(register, 'connect 后必须发 agent:register');
    assert.equal((register!.payload as { agentId: string }).agentId, 'machine-x');

    uplink.send('state:full', { hello: 1 });
    assert.equal(sockets[0].sent.at(-1)!.event, 'state:full');

    sockets[0].fire('disconnect', 'transport close');
    sockets[0].fire('connect_error', new Error('websocket error'));
    // 未超阈值：不重建
    await sleep(5);
    assert.equal(sockets.length, 1);
  });

  it('断线超过阈值 → 拆旧建新：旧 socket removeAllListeners+disconnect，新 socket 重发 register', async () => {
    const { uplink, sockets } = makeUplink(20);
    const disconnectedEvents: string[] = [];
    uplink.on('disconnected', () => disconnectedEvents.push('d'));
    sockets[0].fire('connect');
    sockets[0].fire('disconnect', 'transport close');
    sockets[0].fire('connect_error', new Error('websocket error'));

    await sleep(150);
    assert.equal(sockets.length, 2, 'watchdog 触发重建');
    assert.ok(sockets[0].removeAllListenersCalls >= 1, '旧 socket 摘除监听');
    assert.ok(sockets[0].disconnectCalls >= 1, '旧 socket 显式关闭');
    assert.equal(disconnectedEvents.length, 1, '旧 socket 的 disconnect 只上报一次');

    // 新 socket 走完整握手
    let connectedCount = 0;
    uplink.on('connected', () => connectedCount++);
    sockets[1].fire('connect');
    assert.equal(connectedCount, 1, '重建后 connected 重新发出（index.ts 依赖它重跑 sendFullState）');
    assert.ok(sockets[1].sent.some(s => s.event === 'agent:register'), '新 socket 重发 agent:register');
    uplink.send('state:patch', {});
    assert.equal(sockets[1].sent.at(-1)!.event, 'state:patch', 'send 路由到当前 socket');
    assert.equal(sockets[0].disconnectCalls, 1, '连上后不再动旧 socket');
  });

  it('正常退出（disconnect()）不触发重建', async () => {
    const { uplink, sockets } = makeUplink(20);
    sockets[0].fire('connect');
    sockets[0].fire('disconnect', 'transport close'); // 先 arm watchdog（pending timer）
    uplink.disconnect(); // shutdown 必须取消 pending timer，而非只挡未 arm 的状态
    assert.ok(sockets[0].disconnectCalls >= 1);
    await sleep(120);
    assert.equal(sockets.length, 1, 'shutdown 路径永久停用 watchdog');
  });

  it('重建后旧 socket 事件不再影响 uplink', async () => {
    const { sockets } = makeUplink(20);
    sockets[0].fire('connect');
    sockets[0].fire('disconnect', 'transport close');
    await sleep(150);
    assert.equal(sockets.length, 2);
    const before = sockets[1].sent.length;
    sockets[0].fire('connect'); // 僵尸事件
    sockets[0].fire('agent:sync', { reason: 'stale' });
    await sleep(30);
    assert.equal(sockets[1].sent.length, before, '旧 socket 的事件被摘除，不会驱动新逻辑');
    assert.equal(sockets.length, 2);
  });
});

/**
 * `agent:superseded` is a message to one displaced process (see superseded-outcome.ts): it must reach
 * `index.ts` as its own event, and it must **not** travel the `onAny` path that carries commands —
 * that path exists for command dispatch, and its listeners treat every event as a command.
 */
describe('Uplink instanceId', () => {
  it('registers the injected instanceId, including after a rebuild', async () => {
    const instanceId = 'proc-shared-epoch';
    const { uplink, sockets } = makeUplink(20, instanceId);
    sockets[0]!.fire('connect');
    const first = sockets[0]!.sent.find(entry => entry.event === 'agent:register');
    assert.equal((first?.payload as { instanceId?: string }).instanceId, instanceId);

    sockets[0]!.fire('disconnect', 'transport close');
    await sleep(150);
    assert.equal(sockets.length, 2);
    sockets[1]!.fire('connect');
    const second = sockets[1]!.sent.find(entry => entry.event === 'agent:register');
    assert.equal((second?.payload as { instanceId?: string }).instanceId, instanceId);
    uplink.disconnect();
  });
});

describe('Uplink agent:superseded', () => {
  it('surfaces it as `superseded`, payload intact', () => {
    const { uplink, sockets } = makeUplink();
    sockets[0]!.fire('connect');
    const seen: unknown[] = [];
    uplink.on('superseded', (payload: unknown) => seen.push(payload));
    const payload = { reason: 'duplicate-agent', by: { version: '0.1.84', socketId: 's2', instanceId: 'i2' }, at: 7 };
    sockets[0]!.fire('agent:superseded', payload);
    assert.deepEqual(seen, [payload]);
  });

  it('keeps it off the onAny forwarder, which carries commands, session:get, and cli:sync', () => {
    const { uplink, sockets } = makeUplink();
    sockets[0]!.fire('connect');
    const raw: string[] = [];
    const commands: string[] = [];
    uplink.on('agent:superseded', () => raw.push('agent:superseded'));
    uplink.on('command:ping', () => commands.push('command:ping'));
    sockets[0]!.fire('agent:superseded', { by: { instanceId: 'i2' } });
    sockets[0]!.fire('command:ping', { commandId: 'c1' });
    assert.deepEqual(raw, [], 'the raw event name must not be re-emitted by onAny');
    assert.deepEqual(commands, ['command:ping'], 'command dispatch is untouched');
  });
});

const DARWIN_CLI_ACP: CliAcpCapability = {
  protocolVersion: 1,
  platform: 'darwin',
  sources: [{ source: 'cursor-cli' }, { source: 'codebuddy-cli' }, { source: 'codex-cli' }],
};

describe('static cliAcp', () => {
  it('declares supported CLI sources on darwin and linux and omits the field elsewhere', () => {
    assert.deepEqual(staticCliAcp('darwin', { LIFELINE_LINUX_CDP: '1' }), DARWIN_CLI_ACP);
    assert.deepEqual(staticCliAcp('darwin', {}), DARWIN_CLI_ACP);
    assert.deepEqual(staticCliAcp('linux', {}), { ...DARWIN_CLI_ACP, platform: 'linux' });
    assert.deepEqual(staticCliAcp('linux', { LIFELINE_LINUX_CDP: '1' }), { ...DARWIN_CLI_ACP, platform: 'linux' });
    assert.equal(staticCliAcp('win32', { LIFELINE_LINUX_CDP: '1' }), undefined);
    assert.equal(staticCliAcp('freebsd', { LIFELINE_LINUX_CDP: '1' }), undefined);
  });

  it('puts that capability on agent:register and leaves it off when absent', () => {
    const cap = staticCliAcp('darwin', { LIFELINE_LINUX_CDP: '1' });
    assert.ok(cap);
    const declared = makeUplink(25, 'proc-1', cap);
    declared.sockets[0]!.fire('connect');
    const withCap = declared.sockets[0]!.sent.find(entry => entry.event === 'agent:register');
    assert.deepEqual((withCap?.payload as { cliAcp?: CliAcpCapability }).cliAcp, cap);
    declared.uplink.disconnect();

    const plain = makeUplink();
    plain.sockets[0]!.fire('connect');
    const without = plain.sockets[0]!.sent.find(entry => entry.event === 'agent:register');
    assert.equal('cliAcp' in (without?.payload as object), false);
    plain.uplink.disconnect();
  });

  it('re-registers once without a linux cliAcp when an older server rejects it', () => {
    const cap = staticCliAcp('linux', {});
    assert.ok(cap);
    const { uplink, sockets } = makeUplink(25, 'proc-1', cap);
    let rejected = 0;
    uplink.on('rejected', () => rejected++);
    const registers = () => sockets[0]!.sent.filter(entry => entry.event === 'agent:register').map(entry => entry.payload as { cliAcp?: unknown });

    sockets[0]!.fire('connect');
    assert.equal(registers()[0]?.cliAcp !== undefined, true);
    sockets[0]!.fire('agent:rejected', { reason: 'reject-register' });
    assert.equal(rejected, 0);
    assert.equal(registers().length, 2);
    assert.equal('cliAcp' in (registers()[1] as object), false);

    // Later reconnects keep it off; a second rejection is a real one.
    sockets[0]!.fire('connect');
    assert.equal('cliAcp' in (registers()[2] as object), false);
    sockets[0]!.fire('agent:rejected', { reason: 'reject-register' });
    assert.equal(rejected, 1);
    uplink.disconnect();
  });

  it('does not retry for a darwin cliAcp or for other rejection reasons', () => {
    const darwin = makeUplink(25, 'proc-1', staticCliAcp('darwin', {}));
    let darwinRejected = 0;
    darwin.uplink.on('rejected', () => darwinRejected++);
    darwin.sockets[0]!.fire('connect');
    darwin.sockets[0]!.fire('agent:rejected', { reason: 'reject-register' });
    assert.equal(darwinRejected, 1);
    assert.equal(darwin.sockets[0]!.sent.filter(entry => entry.event === 'agent:register').length, 1);
    darwin.uplink.disconnect();

    const linux = makeUplink(25, 'proc-2', staticCliAcp('linux', {}));
    let linuxRejected = 0;
    linux.uplink.on('rejected', () => linuxRejected++);
    linux.sockets[0]!.fire('connect');
    linux.sockets[0]!.fire('agent:rejected', { reason: 'owner-mismatch' });
    assert.equal(linuxRejected, 1);
    assert.equal(linux.sockets[0]!.sent.filter(entry => entry.event === 'agent:register').length, 1);
    linux.uplink.disconnect();
  });

  it('forwards cli:sync and still drops unrelated events', () => {
    const { uplink, sockets } = makeUplink();
    sockets[0]!.fire('connect');
    const seen: string[] = [];
    uplink.on('cli:sync', () => seen.push('cli:sync'));
    uplink.on('session:get', () => seen.push('session:get'));
    uplink.on('command:ping', () => seen.push('command:ping'));
    uplink.on('cli:snapshot', () => seen.push('cli:snapshot'));
    sockets[0]!.fire('cli:sync', {});
    sockets[0]!.fire('session:get', { sessionId: 's1' });
    sockets[0]!.fire('command:ping', { commandId: 'c1' });
    sockets[0]!.fire('cli:snapshot', { epoch: 'e' });
    assert.deepEqual(seen, ['cli:sync', 'session:get', 'command:ping']);
    uplink.disconnect();
  });

  it('wires the live agent to register staticCliAcp and to follow uplink sync', () => {
    const source = readFileSync(new URL('../packages/agent/src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /cliAcp:\s*staticCliAcp\(\)/);
    assert.match(source, /attachCliUplinkSync\(/);
    assert.doesNotMatch(source, /canControlIde\(\)[\s\S]{0,80}cliAcp/);
  });
});
