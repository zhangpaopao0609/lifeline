import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMMAND_EVENTS,
  commandPayloadSchema,
  emptyCursorState,
  exchangeBodySchema,
  parseIde,
  toAgentPlatform,
  wrapIncomingFull,
} from '@lifeline/protocol';

describe('protocol package', () => {
  it('COMMAND_EVENTS includes switch_window and send_message', () => {
    assert.ok(COMMAND_EVENTS.includes('command:send_message'));
    assert.ok(COMMAND_EVENTS.includes('command:switch_window'));
  });

  it('emptyCursorState has the fields the web and agent both read', () => {
    const s = emptyCursorState();
    assert.equal(s.connected, false);
    assert.equal(s.agentActivitySource, 'none');
    assert.equal(s.questionnaire, null);
  });

  it('parseIde / wrapIncomingFull keep legacy single-IDE payloads', () => {
    assert.equal(parseIde('codebuddy'), 'codebuddy');
    assert.equal(parseIde('nope'), 'cursor');
    const wrapped = wrapIncomingFull({ agentStatus: 'idle', messages: [] });
    assert.ok(wrapped.ides.cursor);
  });

  it('commandPayloadSchema requires commandId', () => {
    assert.equal(commandPayloadSchema.safeParse({}).success, false);
    assert.equal(commandPayloadSchema.safeParse({ commandId: 'c1', text: 'hi' }).success, true);
  });

  // Live upgrade/uninstall commands pick the platform the machine reported; unknown counts as "not reported" and the web UI falls back to the OS toggle
  it('toAgentPlatform keeps the three known platforms and drops the rest', () => {
    assert.equal(toAgentPlatform('win32'), 'win32');
    assert.equal(toAgentPlatform('darwin'), 'darwin');
    assert.equal(toAgentPlatform('linux'), 'linux');
    assert.equal(toAgentPlatform('freebsd'), undefined);
    assert.equal(toAgentPlatform(''), undefined);
    assert.equal(toAgentPlatform(undefined), undefined);
    assert.equal(toAgentPlatform(42), undefined);
  });

  it('exchangeBodySchema requires code and agentId', () => {
    assert.equal(exchangeBodySchema.safeParse({ code: 'abc' }).success, false);
    assert.equal(exchangeBodySchema.safeParse({ code: 'abc', agentId: 'machine-1' }).success, true);
    assert.equal(exchangeBodySchema.safeParse({}).success, false);
  });
});
