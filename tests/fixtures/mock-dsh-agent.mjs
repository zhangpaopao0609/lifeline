// Strict DSH ACP peer: no model service, local credentials, or IDE is contacted.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const tracePath = process.argv[2];
const ids = ['["deepseek-official","model-a"]', '["deepseek-official","model-b"]'];
let model = ids[0];
let effort = 'medium';
let prompt;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function configOptions() {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: [{ group: 'deepseek-official', name: 'DeepSeek', options: ids.map((value, index) => ({ value, name: `Model ${index}` })) }],
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      name: 'Reasoning effort',
      type: 'select',
      currentValue: effort,
      options: (model === ids[0] ? ['medium', 'high'] : ['low', 'high']).map(value => ({ value, name: value })),
    },
  ];
}

function update(value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'dsh-provider-id', update: value } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(tracePath, `${line}\n`);
  const { id, method, params } = message;
  if (method === 'initialize') {
    result(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
  }
  else if (method === 'session/new') {
    result(id, { sessionId: 'dsh-provider-id', configOptions: configOptions() });
  }
  else if (method === 'session/resume') {
    // DSH does not echo a session id or replay history during resume.
    result(id, { configOptions: configOptions() });
  }
  else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      model = params.value;
      effort = model === ids[0] ? 'medium' : 'low';
    }
    else {
      effort = params.value;
    }
    result(id, { configOptions: configOptions() });
  }
  else if (method === 'session/prompt') {
    if (params.prompt[0]?.text === '__FAIL__') {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'turn failed: local test authentication error' } });
      return;
    }
    prompt = id;
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', kind: 'other', status: 'pending', rawInput: { description: 'Run project tests', command: 'npm test', justification: 'Run tests in the temporary workspace.' } });
    send({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'dsh-provider-id',
        toolCall: { toolCallId: 'tool-1' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  }
  else if (method === 'session/cancel') {
    if (prompt !== undefined) {
      result(prompt, { stopReason: 'cancelled' });
      prompt = undefined;
    }
  }
  else if (method === 'session/close') {
    result(id, {});
  }
  else if (method === undefined && id === 'permission-1') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished' } });
    if (prompt !== undefined) {
      result(prompt, { stopReason: 'end_turn' });
      prompt = undefined;
    }
  }
  else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported DSH method: ${method}` } });
  }
});
