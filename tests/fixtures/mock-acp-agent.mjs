/**
 * ACP peer for AcpClient tests.
 * Never launches cursor-agent or codebuddy.
 *
 *   --trace <file>
 *   --permission cursor | codebuddy | unknown
 *   --session-id <id>
 *   --session-shape nested
 *   --fs-request
 *   --exit-on-prompt
 *   --fail-initialize
 */
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--'))
      continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    i += 1;
    out[key] = next;
  }
  return out;
}

function trace(file, entry) {
  if (typeof file !== 'string' || file.length === 0)
    return;
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sessionResult(sessionId, nested) {
  if (nested) {
    return {
      sessionId,
      models: {
        currentModelId: 'm1',
        availableModels: [{ modelId: 'm1', name: 'Model One' }],
      },
      modes: {
        currentModeId: 'agent',
        availableModes: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan' },
          { id: 'ask', name: 'Ask' },
        ],
      },
    };
  }
  return {
    sessionId,
    models: [{ id: 'm1', name: 'Model One' }],
    modes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' },
    ],
  };
}

function permissionParams(kind, sessionId) {
  if (kind === 'codebuddy') {
    return {
      sessionId,
      toolCall: {
        toolCallId: 'tool-2',
        title: '读取文件',
        kind: 'read',
        rawInput: {},
      },
      options: [
        { optionId: 'allow_always', name: '总是允许', kind: 'allow_always' },
        { optionId: 'allow', name: '允许', kind: 'allow' },
        { optionId: 'reject', name: '拒绝', kind: 'reject' },
      ],
    };
  }
  if (kind === 'unknown') {
    return {
      sessionId,
      toolCall: {
        toolCallId: 'tool-3',
        title: '',
        kind: 'execute',
        rawInput: {},
      },
      options: [
        { optionId: 'custom', name: '自定义（不要改）', kind: 'allow-all' },
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' },
      ],
    };
  }
  return {
    sessionId,
    toolCall: {
      toolCallId: 'tool-1',
      title: 'npm test',
      kind: 'execute',
      rawInput: {},
    },
    options: [
      { optionId: 'allow-once', name: '  Allow once  ', kind: 'allow-once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow-always' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject-once' },
    ],
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const traceFile = typeof options.trace === 'string' ? options.trace : undefined;
  const sessionId = typeof options['session-id'] === 'string' ? options['session-id'] : 'prov-session-9';
  trace(traceFile, {
    type: 'env',
    CODEBUDDY_API_KEY: process.env.CODEBUDDY_API_KEY ?? null,
    CODEBUDDY_INTERNET_ENVIRONMENT: process.env.CODEBUDDY_INTERNET_ENVIRONMENT ?? null,
  });

  for (const stream of [process.stdin, process.stdout, process.stderr])
    stream.on('error', () => {});

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '')
      return;
    const message = JSON.parse(line);
    trace(traceFile, { type: 'in', message });
    if (typeof message.method !== 'string')
      return;
    if (message.method === 'initialize') {
      if (options['fail-initialize'] === true) {
        reply({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32001,
            message: `auth failed ${process.env.CODEBUDDY_API_KEY ?? ''}`,
          },
        });
        return;
      }
      reply({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      });
      if (options['fs-request'] === true) {
        reply({
          jsonrpc: '2.0',
          id: 'fs-1',
          method: 'fs/read_text_file',
          params: { path: 'secret.txt', sessionId },
        });
      }
      return;
    }
    if (message.method === 'session/new') {
      reply({
        jsonrpc: '2.0',
        id: message.id,
        result: sessionResult(sessionId, options['session-shape'] === 'nested'),
      });
      reply({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      });
      if (typeof options.permission === 'string') {
        reply({
          jsonrpc: '2.0',
          id: 'perm-1',
          method: 'session/request_permission',
          params: permissionParams(options.permission, sessionId),
        });
      }
      return;
    }
    if (message.method === 'session/prompt') {
      if (options['exit-on-prompt'] === true)
        process.exit(7);
      reply({
        jsonrpc: '2.0',
        id: message.id,
        result: { stopReason: 'end_turn' },
      });
    }
  });
}

main();
