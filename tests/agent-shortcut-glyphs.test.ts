import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();

/**
 * In extractors injected into the page, every character class that "strips shortcut glyphs"
 * must include **`^`**.
 *
 * Why this gets its own guard: on 2026-09-20, live Windows testing showed Cursor 3.21.16
 * approval-button copy as **`Switch^⏎`** (macOS is `Switch⌘⏎`; `^` is the Windows Ctrl glyph).
 * All 5 character classes in the repo were `[⌘⌃⌥⇧⏎]`, so `Switch^⏎` → `Switch^`, every
 * **exact match** against `'switch'` failed → **the whole mode-switch card never entered
 * `pendingApprovals`**, and the web UI showed no approval at all (macOS stayed fine).
 * These snippets are injected via `Function.prototype.toString()` and **cannot share a
 * constant**, so each site has to spell it out; a scan-style assertion pins "missing glyph".
 */
/**
 * Paths follow the **post-IDE-driver-refactor directories** (`packages/agent/src/drivers/<ide>/…`).
 * Do not revert to the old flat list: `dom-extractor.ts` / `codebuddy-extractor.ts` no longer
 * live under `packages/agent/src/`; old paths make all 4 assertions ENOENT (looks like a
 * glyph regression, but the files were never read).
 */
const CURSOR_EXTRACTOR = join('packages', 'agent', 'src', 'drivers', 'cursor', 'extractor.ts');
const CURSOR_AGENTS_WINDOW = join('packages', 'agent', 'src', 'drivers', 'cursor', 'agents-window.ts');
const CODEBUDDY_EXTRACTOR = join('packages', 'agent', 'src', 'drivers', 'codebuddy', 'extractor.ts');
const FILES = [CURSOR_EXTRACTOR, CURSOR_AGENTS_WINDOW, CODEBUDDY_EXTRACTOR];

describe('shortcut glyph classes in the injected extractors', () => {
  for (const file of FILES) {
    it(`${file}: every modifier-glyph class also strips the Windows Ctrl glyph ^`, () => {
      const source = readFileSync(join(ROOT, file), 'utf-8');
      // Only pick character classes that contain ⌘ — those are the shortcut-glyph normalisers
      const classes = [...source.matchAll(/\[[^\]\u2318]*\u2318[^\]]*\]/g)].map(m => m[0]);
      assert.ok(classes.length > 0, `${file} 里没找到任何含 ⌘ 的字符类，扫描逻辑可能失效了`);
      for (const cls of classes) {
        assert.match(
          cls,
          /\^/,
          `${file}: 字符类 ${cls} 少 Windows 的 Ctrl 字形 ^（Windows 上按钮文案是 Switch^⏎）`,
        );
      }
    });
  }

  it('the approval label normaliser strips both glyphs (regression for the ^ bug)', () => {
    const source = readFileSync(join(ROOT, CURSOR_EXTRACTOR), 'utf-8');
    // The one used by actionLabelOf: drop it and the mode-switch card can never be extracted
    assert.match(source, /\[\\s·\]\*\[⌘⌃⌥⇧\^\]\+\\s\*\$/);
  });
});
