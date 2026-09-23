import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('self-host contract', () => {
  // After switching package managers, the repo must not keep an npm lockfile; the container build must not fall back to npm ci.
  it('ships a pnpm lockfile and no npm lockfile', () => {
    assert.equal(existsSync(join(ROOT, 'pnpm-lock.yaml')), true);
    assert.equal(existsSync(join(ROOT, 'pnpm-workspace.yaml')), true);
    assert.equal(existsSync(join(ROOT, 'package-lock.json')), false, 'npm 锁文件必须删干净');
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');
    assert.match(docker, /pnpm install --frozen-lockfile/);
    // Anchored at line start: a comment explaining "why we no longer use npm ci" is allowed; actually running that command is not
    assert.doesNotMatch(docker, /^\s*npm (ci|install)\b/m, 'Docker 构建也不能再用 npm ci');
  });

  // Keep tooling dirs and tests out of the image context (tsc only compiles packages/*/src; the build does not need them).
  it('keeps tooling and tests out of the image build context', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8');
    for (const entry of ['/.agents', '/.cursor', '/.codebuddy', '/tests']) {
      assert.match(dockerignore, new RegExp(`^${entry.replace('.', '\\.')}$`, 'm'), entry);
    }
  });
});
