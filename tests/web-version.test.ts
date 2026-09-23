import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../packages/web/src/lib/app-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'packages/web/src');

/** Recursively list web sources (.ts / .tsx, including .d.ts). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('web version display', () => {
  it('vite bakes the root package.json version in as __APP_VERSION__', () => {
    const vite = readFileSync(join(ROOT, 'packages/web/vite.config.ts'), 'utf-8');
    assert.match(vite, /__APP_VERSION__/);
    assert.match(vite, /\.\.\/\.\.\/package\.json/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本真源必须是 package.json 的 x.y.z');
  });

  it('falls back to a dev marker when loaded without the define', () => {
    // Same rule as the CLI BUILD_VERSION: missing define must not throw ReferenceError
    assert.equal(APP_VERSION, '0.0.0-dev');
  });

  it('never hand-writes a version number into the web sources again', () => {
    const account = readFileSync(join(WEB_SRC, 'components/AccountContent.tsx'), 'utf-8');
    assert.match(account, /Lifeline v\s*\{APP_VERSION\}/);
    const offenders = sourceFiles(WEB_SRC)
      .filter(path => /\bv\d+\.\d+\.\d+/.test(readFileSync(path, 'utf-8')))
      .map(path => path.slice(ROOT.length + 1));
    assert.deepEqual(offenders, [], '版本号只许从构建期常量来（packages/web/src/lib/app-version.ts）');
  });
});
