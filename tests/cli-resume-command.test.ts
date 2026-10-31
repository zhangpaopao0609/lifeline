import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { cliResumeCommand, readCliSessionLedger, writeCliSessionLedger } from '../packages/agent/src/drivers/acp/session-ledger.js';

describe('cli resume command', () => {
  let cwd = '';

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'lifeline-resume-'));
  });

  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('quotes a CodeBuddy command with the saved model and effort', () => {
    const command = cliResumeCommand({
      source: 'codebuddy-cli',
      cwd: '/work/o\'reilly',
      providerSessionId: '01a1856d-1f61-7ca0-9662-92004b89c44e',
      modelId: 'deepseek-v4.1-flash',
      thinking: 'max',
    }, 'darwin');
    assert.equal(
      command,
      'cd \'/work/o\'\\\'\'reilly\' && codebuddy --resume \'01a1856d-1f61-7ca0-9662-92004b89c44e\' --model \'deepseek-v4.1-flash\' --effort \'max\'',
    );
  });

  it('turns a Cursor session id into the CLI model flag and skips effort', () => {
    const command = cliResumeCommand({
      source: 'cursor-cli',
      cwd: '/work',
      providerSessionId: 'chat-1',
      modelId: 'grok-4.7[context=256k,reasoning_effort=low,fast=true]',
      thinking: 'low',
    }, 'darwin');
    assert.equal(command, 'cd \'/work\' && cursor-agent --resume \'chat-1\' --model \'grok-4.7-low-fast\'');
  });

  it('keeps a session when the saved model id is unreadable', () => {
    const ledger = path.join(cwd, 'cli-sessions.json');
    writeCliSessionLedger(ledger, [{
      source: 'codebuddy-cli',
      cwd: '/work',
      providerSessionId: 'session-1',
      modelId: 'deepseek-v4.1-flash',
      thinking: 'max',
    }]);
    const raw = JSON.parse(readFileSync(ledger, 'utf8')) as { sessions: Array<Record<string, unknown>> };
    raw.sessions[0]!.modelId = 'bad\nid';
    writeFileSync(ledger, `${JSON.stringify(raw)}\n`);
    const records = readCliSessionLedger(ledger);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.providerSessionId, 'session-1');
    assert.equal(records[0]?.modelId, undefined);
    assert.equal(records[0]?.thinking, 'max');
  });
});
