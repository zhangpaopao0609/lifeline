import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  formatMissingSqliteError,
  loadBetterSqlite3,
  sqliteRequireBases,
} from '../packages/agent/src/load-sqlite.js';

describe('loadBetterSqlite3', () => {
  it('resolves better-sqlite3 from this package', () => {
    const Database = loadBetterSqlite3();
    assert.equal(typeof Database, 'function');
  });
});

describe('sqliteRequireBases', () => {
  it('includes runtime mjs and legacy sqlite-require.js under home', () => {
    const home = '/tmp/fake-home';
    const bases = sqliteRequireBases(home);
    assert.equal(bases.length, 3);
    assert.match(bases[0]!, /^file:/);
    assert.equal(
      bases[1],
      pathToFileURL(join(home, '.lifeline', 'runtime', 'lifeline.mjs')).href,
    );
    assert.equal(
      bases[2],
      pathToFileURL(join(home, '.lifeline', 'sqlite-require.js')).href,
    );
  });

  it('defaults home to homedir()', () => {
    const bases = sqliteRequireBases();
    assert.equal(
      bases[1],
      pathToFileURL(join(homedir(), '.lifeline', 'runtime', 'lifeline.mjs')).href,
    );
  });
});

describe('formatMissingSqliteError', () => {
  it('tells the user to re-run install.sh from their server (no hardcoded host)', () => {
    const msg = formatMissingSqliteError(['nope']);
    assert.match(msg, /install\.sh/);
    assert.match(msg, /curl -fsSL http:\/\/<your-lifeline-server>\/public\/install\.sh \| sh/);
    assert.doesNotMatch(msg, /npm install --prefix ~\/\.lifeline better-sqlite3/);
    assert.match(msg, /nope/);
  });
});
