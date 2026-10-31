import type { CliApproval } from '@lifeline/protocol';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codebuddyAcpProfile, cursorAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';

describe('ACP profiles', () => {
  it('spawns cursor-agent acp and classifies only the cursor kind table', () => {
    assert.equal(cursorAcpProfile.source, 'cursor-cli');
    assert.deepEqual([cursorAcpProfile.command, ...cursorAcpProfile.args], ['cursor-agent', 'acp']);
    assert.equal(cursorAcpProfile.mapOptionKind('allow-once'), 'allow_once');
    assert.equal(cursorAcpProfile.mapOptionKind('allow-always'), 'allow_always');
    assert.equal(cursorAcpProfile.mapOptionKind('reject-once'), 'reject_once');
    for (const kind of ['allow', 'allow_always', 'reject', 'allow_once', 'allow_always', 'allow-all', 'Allow-Once', ''])
      assert.equal(cursorAcpProfile.mapOptionKind(kind), 'unknown', kind);
  });

  it('spawns codebuddy --acp and classifies only the codebuddy kind table', () => {
    assert.equal(codebuddyAcpProfile.source, 'codebuddy-cli');
    assert.deepEqual([codebuddyAcpProfile.command, ...codebuddyAcpProfile.args], ['codebuddy', '--acp']);
    assert.equal(codebuddyAcpProfile.mapOptionKind('allow_always'), 'allow_always');
    assert.equal(codebuddyAcpProfile.mapOptionKind('allow'), 'allow_once');
    assert.equal(codebuddyAcpProfile.mapOptionKind('reject'), 'reject_once');
    for (const kind of ['allow-once', 'allow-always', 'reject-once', 'allow_once', 'reject_once', 'allow-all', ''])
      assert.equal(codebuddyAcpProfile.mapOptionKind(kind), 'unknown', kind);
  });

  it('builds a cursor CliApproval from an empty rawInput without rewriting the label', () => {
    const approval = cursorAcpProfile.toCliApproval({
      sessionId: 'provider-session',
      toolCall: {
        toolCallId: 'tool-1',
        title: '  npm test  ',
        kind: 'execute',
        rawInput: {},
      },
      options: [
        { optionId: 'allow-once', name: '  Allow once  ', kind: 'allow-once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow-always' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject-once' },
        { optionId: 'custom', name: '自定义', kind: 'allow-all' },
      ],
    }, 'approval-1', 'lifeline-session-1');

    assert.deepEqual(approval, {
      approvalId: 'approval-1',
      sessionId: 'lifeline-session-1',
      title: '  npm test  ',
      state: 'pending',
      options: [
        { optionId: 'allow-once', label: '  Allow once  ', kind: 'allow_once' },
        { optionId: 'allow-always', label: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', label: 'Reject once', kind: 'reject_once' },
        { optionId: 'custom', label: '自定义', kind: 'unknown' },
      ],
    });
    assert.equal(JSON.stringify(approval).includes('provider-session'), false);
  });

  it('uses toolCall.title when rawInput is missing, null, or an empty string', () => {
    for (const rawInput of [undefined, null, '']) {
      const approval = cursorAcpProfile.toCliApproval({
        toolCall: { title: 'ls -la', kind: 'execute', rawInput },
        options: [],
      }, 'approval-2', 'lifeline-session-2');
      assert.equal(approval.title, 'ls -la');
    }
  });

  it('uses the ACP tool kind when rawInput is empty and title is missing', () => {
    for (const toolCall of [
      { kind: 'execute', rawInput: {} },
      { title: '', kind: 'execute', rawInput: {} },
      { title: '', kind: 'execute' },
    ]) {
      const approval = cursorAcpProfile.toCliApproval({
        toolCall,
        options: [],
      }, 'approval-3', 'lifeline-session-3');
      assert.equal(approval.title, 'execute');
    }
  });

  it('keeps a provider label field verbatim when name is absent', () => {
    const approval = cursorAcpProfile.toCliApproval({
      toolCall: { title: 'npm test', kind: 'execute', rawInput: {} },
      options: [{ optionId: 'allow-once', label: '  允许一次  ', kind: 'allow-once' }],
    }, 'approval-4', 'lifeline-session-4');
    assert.equal(approval.options[0]?.label, '  允许一次  ');
  });

  it('builds a codebuddy CliApproval with the same shape and caller-supplied ids', () => {
    const approval = codebuddyAcpProfile.toCliApproval({
      sessionId: 'provider-session',
      toolCall: { title: '读取文件', kind: 'read', rawInput: {} },
      options: [
        { optionId: 'allow_always', name: '总是允许', kind: 'allow_always' },
        { optionId: 'allow', name: '允许', kind: 'allow' },
        { optionId: 'reject', name: '拒绝', kind: 'reject' },
        { optionId: 'other', name: '别的', kind: 'allow-once' },
      ],
    }, 'approval-5', 'lifeline-session-5');

    assert.deepEqual(approval, {
      approvalId: 'approval-5',
      sessionId: 'lifeline-session-5',
      title: '读取文件',
      state: 'pending',
      options: [
        { optionId: 'allow_always', label: '总是允许', kind: 'allow_always' },
        { optionId: 'allow', label: '允许', kind: 'allow_once' },
        { optionId: 'reject', label: '拒绝', kind: 'reject_once' },
        { optionId: 'other', label: '别的', kind: 'unknown' },
      ],
    });
    assert.equal(JSON.stringify(approval).includes('provider-session'), false);
  });

  it('returns the same CliApproval key shape from both profiles', () => {
    const raw = {
      toolCall: { title: 'npm test', kind: 'execute', rawInput: {} },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow-once' }],
    };
    const cursor = cursorAcpProfile.toCliApproval(raw, 'approval-6', 'lifeline-session-6');
    const codebuddy = codebuddyAcpProfile.toCliApproval({
      ...raw,
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow' }],
    }, 'approval-6', 'lifeline-session-6');
    assert.deepEqual(approvalShape(cursor), approvalShape(codebuddy));
    assert.deepEqual(approvalShape(cursor), {
      keys: ['approvalId', 'options', 'sessionId', 'state', 'title'],
      optionKeys: ['kind', 'label', 'optionId'],
      state: 'pending',
    });
  });

  it('does not inject CodeBuddy env from the cursor profile', () => {
    const base = {
      PATH: '/usr/bin',
      CODEBUDDY_API_KEY: 'inherited-key',
      CODEBUDDY_INTERNET_ENVIRONMENT: 'prod',
    };
    const env = cursorAcpProfile.childEnv({
      apiKey: 'llk_test',
      environment: 'ioa',
      base,
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal('CODEBUDDY_API_KEY' in env, false);
    assert.equal('CODEBUDDY_INTERNET_ENVIRONMENT' in env, false);
    assert.equal(base.CODEBUDDY_API_KEY, 'inherited-key');
  });

  it('sets only CODEBUDDY_API_KEY and CODEBUDDY_INTERNET_ENVIRONMENT for codebuddy', () => {
    const withKey = codebuddyAcpProfile.childEnv({
      apiKey: 'llk_test',
      environment: 'ioa',
      base: { PATH: '/usr/bin' },
    });
    assert.equal(withKey.PATH, '/usr/bin');
    assert.equal(withKey.CODEBUDDY_API_KEY, 'llk_test');
    assert.equal(withKey.CODEBUDDY_INTERNET_ENVIRONMENT, 'ioa');
    assert.deepEqual(Object.keys(withKey).sort(), [
      'CODEBUDDY_API_KEY',
      'CODEBUDDY_INTERNET_ENVIRONMENT',
      'PATH',
    ]);

    const withoutKey = codebuddyAcpProfile.childEnv({
      environment: 'ioa',
      base: { PATH: '/usr/bin' },
    });
    assert.equal('CODEBUDDY_API_KEY' in withoutKey, false);
    assert.equal(withoutKey.CODEBUDDY_INTERNET_ENVIRONMENT, 'ioa');

    const blank = codebuddyAcpProfile.childEnv({
      apiKey: '',
      environment: '',
      base: { PATH: '/usr/bin' },
    });
    assert.deepEqual(blank, { PATH: '/usr/bin' });
  });
});

function approvalShape(approval: CliApproval) {
  return {
    keys: Object.keys(approval).sort(),
    optionKeys: Object.keys(approval.options[0] ?? {}).sort(),
    state: approval.state,
  };
}
