import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workspaceIdentityFromUri } from '../packages/agent/src/cdp/bridge.ts';

describe('workspaceIdentityFromUri', () => {
  it('keeps the folder name and the local absolute path', () => {
    assert.deepEqual(
      workspaceIdentityFromUri({ path: '/Users/me/proj', authority: '' }),
      { name: 'proj', localPath: '/Users/me/proj' },
    );
  });

  it('drops the path when the workspace is remote', () => {
    const identity = workspaceIdentityFromUri({
      path: '/home/me/proj',
      authority: 'ssh-remote+2a',
    });
    assert.equal(identity?.localPath, undefined);
    assert.match(identity?.name ?? '', /^proj /);
  });

  it('returns null when there is no path', () => {
    assert.equal(workspaceIdentityFromUri({ path: '', authority: '' }), null);
  });

  it('does not treat a relative path as a local workspace', () => {
    assert.deepEqual(
      workspaceIdentityFromUri({ path: 'proj', authority: '' }),
      { name: 'proj' },
    );
  });
});
