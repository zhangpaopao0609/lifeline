import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveAcpLaunch } from '../packages/agent/src/drivers/acp/live-entry.js';
import { acpProfileFor, codexAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import { cliResumeCommand } from '../packages/agent/src/drivers/acp/session-ledger.js';
import {
  describeTool,
  pickEffort,
  promptText,
  readModels,
  sessionModelsPayload,
  shortCommand,
  shortPath,
  toolTitle,
  turnSummary,
} from '../packages/agent/src/drivers/codex/items.js';
import { CODEX_BRIDGE_SUBCOMMAND, codexBridgeLaunch, isExecutableFile } from '../packages/agent/src/drivers/codex/launch.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true });
});

describe('codex item mapping', () => {
  it('strips the shell wrapper and keeps titles one short line', () => {
    assert.equal(shortCommand('/bin/bash -lc \'git status\''), 'git status');
    assert.equal(shortCommand('bash -lc "ls -la"'), 'ls -la');
    assert.equal(shortCommand('/usr/bin/zsh -c \'echo hi\''), 'echo hi');
    assert.equal(shortCommand('pytest -q'), 'pytest -q');
    const long = shortCommand(`echo ${'x'.repeat(200)}`);
    assert.equal(long.length, 73);
    assert.equal(long.endsWith('…'), true);
  });

  it('makes paths relative to the session and middle-truncates them', () => {
    assert.equal(shortPath('/work', '/work/src/a.ts'), 'src/a.ts');
    assert.equal(shortPath('/work', '/elsewhere/a.ts'), '/elsewhere/a.ts');
    const long = shortPath('/w', `/w/${'d/'.repeat(40)}file.ts`);
    assert.equal(long.length, 56);
    assert.equal(long.startsWith('…'), true);
    assert.equal(long.endsWith('file.ts'), true);
  });

  it('puts the status into the tool title', () => {
    const cmd = { type: 'commandExecution', command: 'bash -lc \'make\'', exitCode: 2 };
    assert.equal(toolTitle(cmd, 'in_progress', '/w'), '▸ $ make');
    assert.equal(toolTitle(cmd, 'completed', '/w'), '✓ $ make');
    assert.equal(toolTitle(cmd, 'failed', '/w'), '✗ $ make（exit 2）');
    assert.equal(toolTitle(cmd, 'cancelled', '/w'), '⊘ $ make');
    const edit = { type: 'fileChange', changes: [{ path: '/w/a.ts', diff: '' }, { path: '/w/b.ts', diff: '' }] };
    assert.equal(toolTitle(edit, 'completed', '/w'), '✓ ✎ a.ts 等 2 个文件');
    assert.deepEqual(describeTool(edit, '/w')?.locations, [{ path: '/w/a.ts' }, { path: '/w/b.ts' }]);
    assert.equal(describeTool({ type: 'agentMessage', text: 'hi' }, '/w'), null);
    assert.equal(toolTitle({ type: 'reasoning' }, 'completed', '/w'), undefined);
  });

  it('summarizes a finished turn in one row', () => {
    assert.equal(turnSummary([
      { type: 'userMessage' },
      { type: 'commandExecution', status: 'completed', exitCode: 0 },
      { type: 'commandExecution', status: 'completed', exitCode: 1 },
      { type: 'fileChange', changes: [{ path: '/w/a' }, { path: '/w/b' }] },
      { type: 'fileChange', changes: [{ path: '/w/a' }] },
      { type: 'webSearch', query: 'x' },
      { type: 'agentMessage', text: 'done' },
    ], '/w'), '· 命令 2 条（失败 1），改动 2 个文件，其他工具 1 次');
    assert.equal(turnSummary([{ type: 'userMessage' }, { type: 'agentMessage', text: 'hi' }], '/w'), '');
  });

  it('reads visible models and keeps a chosen effort only when the model allows it', () => {
    const models = readModels([
      { id: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
      { id: 'b', supportedReasoningEfforts: [] },
      { id: 'h', hidden: true },
      'junk',
    ]);
    assert.deepEqual(models.map(m => m.id), ['a', 'b']);
    assert.equal(models[1]?.displayName, 'b');
    assert.equal(pickEffort(models, 'a', 'low'), 'low');
    assert.equal(pickEffort(models, 'a', 'max'), 'high');
    assert.equal(pickEffort(models, 'b', 'max'), 'max');
    assert.equal(pickEffort(models, 'unknown', 'low'), 'low');
  });

  it('exposes the model and thought_level dials Lifeline binds to', () => {
    const models = readModels([
      { id: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
      { id: 'b', displayName: 'B', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
    ]);
    const payload = sessionModelsPayload(models, 'a', 'high') as {
      models: { currentModelId: string; availableModels: Array<{ modelId: string; _meta: { effortOptions: Array<{ value: string }> } }> };
      configOptions: Array<{ id: string; category: string; currentValue: unknown; options: Array<{ value: string }> }>;
    };
    assert.equal(payload.models.currentModelId, 'a');
    assert.deepEqual(payload.models.availableModels[0]?._meta.effortOptions.map(o => o.value), ['high', 'low']);
    assert.deepEqual(payload.configOptions.map(o => [o.id, o.category]), [['model', 'model'], ['thought_level', 'thought_level']]);
    assert.deepEqual(payload.configOptions[1]?.options.map(o => o.value), ['low', 'high', 'max']);
    assert.equal(payload.configOptions[1]?.currentValue, 'high');
  });

  it('flattens ACP prompt blocks into one text input', () => {
    assert.equal(promptText([
      { type: 'text', text: 'look at' },
      { type: 'resource_link', uri: 'file:///w/a.ts' },
      { type: 'resource', resource: { text: 'inline' } },
      { type: 'image', data: 'x' },
    ]), 'look at\n/w/a.ts\ninline');
  });
});

describe('codex launch', () => {
  it('bundled runtime re-enters its own entry with the hidden subcommand', () => {
    const launch = codexBridgeLaunch(pathToFileURL('/home/me/.lifeline/runtime/lifeline.mjs').href, '/rt/node', ['--max-old-space-size=4096']);
    assert.deepEqual(launch, { command: '/rt/node', args: ['/home/me/.lifeline/runtime/lifeline.mjs', CODEX_BRIDGE_SUBCOMMAND] });
    // Must not look like a running agent to the process scan.
    assert.equal(launch.args.includes('run') || launch.args.includes('start'), false);
  });

  it('a source run keeps only loader flags, pinned to absolute files', () => {
    const launch = codexBridgeLaunch(pathToFileURL('/repo/packages/agent/src/drivers/codex/launch.ts').href, '/bin/node', [
      '--import',
      'tsx',
      '--inspect',
      '--require=/abs/preflight.cjs',
    ]);
    assert.equal(launch.command, '/bin/node');
    assert.equal(launch.args.at(-1), '/repo/packages/agent/src/drivers/codex/main.ts');
    assert.equal(launch.args[0], '--import');
    assert.match(launch.args[1]!, /^file:\/\/.*tsx/);
    assert.equal(launch.args[2], '--require=/abs/preflight.cjs');
    assert.equal(launch.args.includes('--inspect'), false);
  });

  it('codex counts as present only as an executable file, and then launches the bridge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-codex-launch-'));
    dirs.push(dir);
    const plain = join(dir, 'codex-plain');
    const exe = join(dir, 'codex');
    writeFileSync(plain, '');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    assert.equal(isExecutableFile(exe), true);
    assert.equal(isExecutableFile(plain), false);
    assert.equal(isExecutableFile(dir), false);
    assert.equal(isExecutableFile('codex'), false);
    assert.equal(resolveAcpLaunch({}, 'codex-cli'), undefined);
    assert.equal(resolveAcpLaunch({ LIFELINE_CODEX_CLI: plain }, 'codex-cli'), undefined);
    assert.deepEqual(resolveAcpLaunch({ LIFELINE_CODEX_CLI: exe }, 'codex-cli'), codexBridgeLaunch());
    assert.deepEqual(resolveAcpLaunch({ LIFELINE_CODEBUDDY_CLI: '/opt/codebuddy' }, 'codebuddy-cli'), { command: '/opt/codebuddy', args: ['--acp'] });
    assert.deepEqual(resolveAcpLaunch({ LIFELINE_CURSOR_CLI: '/opt/cursor-agent' }, 'cursor-cli'), { command: '/opt/cursor-agent', args: ['acp'] });
    assert.equal(resolveAcpLaunch({ LIFELINE_CURSOR_CLI: 'cursor-agent' }, 'cursor-cli'), undefined);
  });
});

describe('codex profile and resume', () => {
  it('maps ACP spec option kinds and keeps CodeBuddy secrets out of the child env', () => {
    assert.equal(acpProfileFor('codex-cli'), codexAcpProfile);
    assert.equal(codexAcpProfile.mapOptionKind('allow_once'), 'allow_once');
    assert.equal(codexAcpProfile.mapOptionKind('allow_always'), 'allow_always');
    assert.equal(codexAcpProfile.mapOptionKind('reject_once'), 'reject_once');
    assert.equal(codexAcpProfile.mapOptionKind('allow'), 'unknown');
    const env = codexAcpProfile.childEnv({ base: { PATH: '/bin', CODEBUDDY_API_KEY: 'k', OPENAI_API_KEY: 'o' }, apiKey: 'k2' });
    assert.equal(env.CODEBUDDY_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, 'o');
  });

  it('resumes the codex thread with the configured binary, model and effort', () => {
    const record = { source: 'codex-cli' as const, cwd: '/work dir', providerSessionId: '01a1-thread', modelId: 'gpt-5', thinking: 'high' };
    assert.equal(
      cliResumeCommand(record, 'linux', '/home/me/.local/bin/my-codex'),
      `cd '/work dir' && '/home/me/.local/bin/my-codex' resume '01a1-thread' -m 'gpt-5' -c 'model_reasoning_effort="high"'`,
    );
    assert.equal(
      cliResumeCommand({ source: 'codex-cli', cwd: '/w', providerSessionId: 't' }, 'linux'),
      `cd '/w' && codex resume 't'`,
    );
  });
});
