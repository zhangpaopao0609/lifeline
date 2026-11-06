import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { machineNotice } from '../packages/web/src/lib/duplicate-agent.js';

/**
 * The console notice for a displaced agent. The scenario it exists for: a dev build wins the slot,
 * the row's version chip shows `0.0.0-dev`, and the notice must name the release that lost it —
 * otherwise the page looks like "the release is running, in a weird state".
 */
describe('machineNotice', () => {
  it('says nothing about a healthy release machine', () => {
    assert.deepEqual(machineNotice({ cliVersion: '0.1.83' }), { devBuild: false });
  });

  it('names the displaced release when the slot was taken over', () => {
    const notice = machineNotice({
      cliVersion: '0.1.83',
      duplicateAgent: { at: 1, version: '0.1.82', socketId: 's1' },
    });
    assert.equal(notice.displaced, '已顶替 v0.1.82');
    assert.equal(notice.devBuild, false);
  });

  it('marks a dev build that displaced a release: the row must not look healthy', () => {
    const notice = machineNotice({
      cliVersion: '0.0.0-dev',
      duplicateAgent: { at: 1, version: '0.1.82', socketId: 's1' },
    });
    assert.equal(notice.displaced, '已顶替 v0.1.82');
    assert.equal(notice.devBuild, true);
  });

  it('marks a dev build without a record, and stays quiet for an unreported version', () => {
    assert.deepEqual(machineNotice({ cliVersion: '0.0.0-dev' }), { devBuild: true });
    // An old agent reports no version at all: "unknown" is not a dev build.
    assert.deepEqual(machineNotice({}), { devBuild: false });
  });

  it('names a displaced process that never reported a version', () => {
    const notice = machineNotice({ cliVersion: '0.1.83', duplicateAgent: { at: 1, socketId: 's1' } });
    assert.equal(notice.displaced, '已顶替旧 agent');
  });

  it('is rendered on every machine row, including read-only ones', () => {
    // One row template draws controllable and content-only machines. The notice has to live in that
    // template: a second list that forgot it would hide a displaced Linux agent.
    const list = readFileSync(
      fileURLToPath(new URL('../packages/web/src/components/MachineList.tsx', import.meta.url)),
      'utf-8',
    );
    const mapAt = list.indexOf('machines.map');
    assert.notEqual(mapAt, -1, 'missing the machine map');
    assert.equal(list.includes('contentSources.map'), false);
    const rows = list.slice(mapAt);
    assert.match(rows, /machineNotice\(m\)/);
    assert.match(rows, /\{notice\.displaced &&/);
    assert.match(rows, /\{notice\.devBuild &&/);
    assert.match(rows, /m\.contentOnly/);
  });
});
