import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { installTheme, useThemeStore } from '../packages/web/src/store/theme.ts';

const HTML = readFileSync(new URL('../packages/web/index.html', import.meta.url), 'utf8');

function page(t: TestContext, { saved, dark = false, blocked = false }: { saved?: string; dark?: boolean; blocked?: boolean } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://lifeline.test', runScripts: 'outside-only' });
  const originals = ['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const listeners = new Set<() => void>();
  const media = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(dom.window, 'matchMedia', { value: () => media });
  if (saved !== undefined)
    dom.window.localStorage.setItem('lifeline:theme', saved);
  if (blocked) {
    Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  }
  const bootstrap = () => dom.window.eval(dom.window.document.scripts[0].textContent!);
  bootstrap();
  const root = dom.window.document.documentElement;
  const firstPaint = root.dataset.theme;
  const uninstall = installTheme();
  t.after(() => {
    uninstall();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor)
        Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    root,
    firstPaint,
    storage: blocked ? undefined : dom.window.localStorage,
    bootstrap,
    uninstall,
    listeners,
    systemChange(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('web theme', () => {
  for (const [saved, dark, expected] of [
    [undefined, false, 'dark'],
    [undefined, true, 'dark'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['invalid', false, 'dark'],
  ] as const) {
    it(`restores ${saved ?? 'default'} with system dark=${dark} before first paint`, (t) => {
      const p = page(t, { saved, dark });
      assert.equal(p.firstPaint, expected);
      assert.equal(p.root.dataset.theme, expected);
      assert.equal(p.root.style.colorScheme, expected);
      assert.equal(useThemeStore.getState().preference, saved === 'light' || saved === 'system' ? saved : 'dark');
    });
  }

  it('persists manual choices and ignores system changes until system is selected', (t) => {
    const p = page(t);
    useThemeStore.getState().setPreference('light');
    p.systemChange(true);
    assert.equal(p.root.dataset.theme, 'light');
    assert.equal(p.storage!.getItem('lifeline:theme'), 'light');
    p.bootstrap();
    assert.equal(p.root.dataset.theme, 'light', 'refresh restores the manual choice');

    useThemeStore.getState().setPreference('dark');
    p.systemChange(false);
    assert.equal(p.root.dataset.theme, 'dark');
    assert.equal(p.root.style.colorScheme, 'dark');
    assert.equal(p.storage!.getItem('lifeline:theme'), 'dark');

    useThemeStore.getState().setPreference('system');
    assert.equal(p.root.dataset.theme, 'light', 'returning to system applies its current value immediately');
    assert.equal(p.storage!.getItem('lifeline:theme'), 'system');
    p.systemChange(true);
    assert.equal(p.root.dataset.theme, 'dark');
    assert.equal(p.root.style.colorScheme, 'dark');
    p.systemChange(false);
    assert.equal(p.root.dataset.theme, 'light');
    assert.equal(p.root.style.colorScheme, 'light');
    assert.equal(useThemeStore.getState().preference, 'system');
  });

  it('still switches when reading and writing storage is blocked', (t) => {
    const p = page(t, { blocked: true });
    assert.equal(p.firstPaint, 'dark');
    assert.doesNotThrow(() => useThemeStore.getState().setPreference('light'));
    assert.equal(p.root.dataset.theme, 'light');
    assert.equal(p.root.style.colorScheme, 'light');
  });

  it('installs one system listener and removes subscriptions on cleanup', (t) => {
    const p = page(t, { saved: 'system' });
    assert.equal(p.listeners.size, 1);
    p.uninstall();
    assert.equal(p.listeners.size, 0);
    p.systemChange(true);
    useThemeStore.getState().setPreference('dark');
    assert.equal(p.root.dataset.theme, 'light');
  });
});
