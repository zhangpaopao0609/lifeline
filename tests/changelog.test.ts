import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const VERSIONS = [
  '0.5.0',
  '0.4.0',
  '0.3.0',
  '0.2.4',
  '0.2.3',
  '0.2.2',
  '0.2.1',
  '0.2.0',
  '0.1.91',
  '0.1.90',
  '0.1.89',
] as const;

interface Category {
  name: string;
  count: number;
}

interface Release {
  version: string;
  date: string;
  categories: Category[];
}

const CATEGORY_EN: Record<string, string> = { 'Features': 'Features', 'Bug Fixes': 'Bug Fixes' };
const CATEGORY_ZH: Record<string, string> = { 功能: 'Features', 修复: 'Bug Fixes' };

function parseChangelog(markdown: string, names: Record<string, string>): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  let category: Category | null = null;
  const categoryHeadingPattern = new RegExp(`^### (${Object.keys(names).join('|')})$`);
  for (const line of markdown.split('\n')) {
    const heading = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (heading) {
      current = { version: heading[1], date: heading[2], categories: [] };
      releases.push(current);
      category = null;
      continue;
    }
    const categoryHeading = categoryHeadingPattern.exec(line);
    if (categoryHeading) {
      assert.ok(current, `category before a version heading: ${line}`);
      category = { name: names[categoryHeading[1]], count: 0 };
      current.categories.push(category);
      continue;
    }
    if (line.startsWith('- ')) {
      assert.ok(category, `bullet before a category: ${line}`);
      category.count += 1;
    }
  }
  return releases;
}

function readReleaseNotes(name: string): string {
  return readFileSync(join(ROOT, name), 'utf8');
}

function loadChangelogs(): { english: string; chinese: string; englishReleases: Release[]; chineseReleases: Release[]; version: string } {
  const english = readReleaseNotes('CHANGELOG.md');
  const chinese = readReleaseNotes('CHANGELOG.zh-CN.md');
  return {
    english,
    chinese,
    englishReleases: parseChangelog(english, CATEGORY_EN),
    chineseReleases: parseChangelog(chinese, CATEGORY_ZH),
    version: (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version,
  };
}

describe('changelog', () => {
  it('links the two language files from each header', () => {
    const { english, chinese } = loadChangelogs();
    assert.match(english, /\*\*English\*\* \| \[简体中文\]\(\.\/CHANGELOG\.zh-CN\.md\)/);
    assert.match(chinese, /\[English\]\(\.\/CHANGELOG\.md\) \| \*\*简体中文\*\*/);
  });

  it('names categories in the language of each file', () => {
    const { english, chinese } = loadChangelogs();
    assert.match(english, /^### Features$/m);
    assert.doesNotMatch(english, /^### Added$/m);
    assert.match(chinese, /^### 功能$/m);
    assert.doesNotMatch(chinese, /^### Bug Fixes$/m);
  });

  it('keeps the same versions, dates, categories, and bullet counts in both languages', () => {
    const { englishReleases, chineseReleases } = loadChangelogs();
    assert.deepEqual(englishReleases, chineseReleases);
  });

  it('lists 0.1.89 through the package version, newest first', () => {
    const { englishReleases, version } = loadChangelogs();
    assert.deepEqual(englishReleases.map(release => release.version), [...VERSIONS]);
    assert.equal(englishReleases[0]?.version, version);
    assert.equal(englishReleases.at(-1)?.version, '0.1.89');
  });

  it('gives every category at least one bullet', () => {
    const { englishReleases } = loadChangelogs();
    for (const release of englishReleases) {
      assert.ok(release.categories.length > 0, `${release.version} has no categories`);
      for (const category of release.categories)
        assert.ok(category.count > 0, `${release.version} ${category.name} is empty`);
    }
  });
});
