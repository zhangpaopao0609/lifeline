import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { versionBumpVerdict } from '../scripts/check-version-bump.ts';

/**
 * Poka-yoke for the split numbers (docs/release.md), run from `pre-push`.
 *
 * Two directions, two severities — and deliberately no third "block the push for something ambiguous":
 * the blocking case is the one where a machine-side change can never reach a machine.
 */
const ok = { machineSideSinceBump: [], bumpShippedMachineSide: true, introducedHere: false } as const;

describe('version bump guard', () => {
  it('passes a clean history', () => {
    assert.deepEqual(versionBumpVerdict(ok), {});
  });

  it('blocks when machine-side code changed after the last cliVersion bump', () => {
    const verdict = versionBumpVerdict({
      ...ok,
      machineSideSinceBump: ['packages/agent/src/uplink.ts', 'packages/protocol/src/wire.ts'],
    });
    assert.ok(verdict.error, 'this is the 2026-10-05 failure: machines would never pull it');
    assert.equal(verdict.warning, undefined);
    assert.match(verdict.error, /packages\/agent\/src\/uplink\.ts/);
    assert.match(verdict.error, /cliVersion/);
  });

  it('truncates a long change list instead of dumping the whole diff stat', () => {
    const files = Array.from({ length: 8 }, (_, i) => `packages/cli/src/f${i}.ts`);
    const verdict = versionBumpVerdict({ ...ok, machineSideSinceBump: files });
    assert.match(verdict.error ?? '', /f4\.ts/);
    assert.doesNotMatch(verdict.error ?? '', /f5\.ts/, '只列前 5 个');
    assert.match(verdict.error ?? '', /… 3 more/);
  });

  it('warns when the last bump shipped no machine-side change (noise for every machine)', () => {
    const verdict = versionBumpVerdict({ ...ok, bumpShippedMachineSide: false });
    assert.equal(verdict.error, undefined);
    assert.match(verdict.warning ?? '', /identical build/);
  });

  it('stays quiet for the commit that introduced the field', () => {
    // The introduction commit is by definition "a bump with no machine-side change" — warning there would nag
    // on every push until the next real bump.
    assert.deepEqual(versionBumpVerdict({ ...ok, bumpShippedMachineSide: false, introducedHere: true }), {});
  });

  it('stays quiet when the bump commit cannot be diffed (root commit / shallow history)', () => {
    assert.deepEqual(versionBumpVerdict({ ...ok, bumpShippedMachineSide: null }), {});
  });

  it('reports the blocking case even when the anchor has no parent', () => {
    const verdict = versionBumpVerdict({
      machineSideSinceBump: ['packages/agent/src/index.ts'],
      bumpShippedMachineSide: null,
      introducedHere: true,
    });
    assert.ok(verdict.error);
  });
});
