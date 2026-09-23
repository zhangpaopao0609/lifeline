/**
 * Slate fiber scripts for CodeBuddy send.
 * Copied from temp/disk-first-exp/test-verified.mjs (HELPERS + insertText + onEnter).
 * Never assign editor.children. Never use CDP Input.insertText.
 */

export const FIBER_HELPERS_JS = `
  window.__dfV = (() => {
    const shell = document.getElementById('active-frame');
    let root = document;
    try { const cd = shell && shell.contentDocument; if (cd && cd.body) root = cd; } catch (e) {}
    const api = { root };
    api.host = () => root.querySelector('[class*="chat-input-module_container"]');
    api.input = () => { const h = api.host(); return h ? h.querySelector('[data-slate-editor="true"]') : null; };
    api.walk = () => {
      const INPUT = api.input();
      if (!INPUT) return [];
      const fk = Object.keys(INPUT).find((k) => k.startsWith('__reactFiber$'));
      if (!fk) return [];
      const out = []; let f = INPUT[fk], d = 0;
      while (f && d < 60) {
        const nm = (f.type && (f.type.displayName || f.type.name)) ||
          (f.elementType && (f.elementType.displayName || f.elementType.name)) ||
          (typeof f.type === 'string' ? f.type : null) || '?';
        out.push({ depth: d, name: String(nm).slice(0, 30), props: f.memoizedProps });
        f = f.return; d++;
      }
      return out;
    };
    api.editor = () => {
      for (const c of api.walk()) {
        const ed = c.props && c.props.editor;
        if (ed && Array.isArray(ed.children) && typeof ed.apply === 'function') return ed;
      }
      return null;
    };
    api.onEnter = () => {
      for (const c of api.walk()) {
        if (c.props && typeof c.props.onEnter === 'function') return c.props.onEnter;
      }
      return null;
    };
    api.users = () => Array.from(root.querySelectorAll('[id^="user-message-"]'))
      .map((e) => (e.textContent || '').trim().slice(0, 70));
    return api;
  })();
  'ok'
`;

const FIBER_TEXT_TOKEN = '__FIBER_TEXT__';

export const FIBER_INSERT_JS = `
(() => {
  const ed = window.__dfV.editor();
  if (!ed) return { err: 'no editor' };
  try {
    const node = ed.children[0];
    const len = node && node.children && node.children[0] ? String(node.children[0].text || '').length : 0;
    if (len > 0) {
      ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: len } };
      ed.deleteFragment();
    }
  } catch (e) {}
  ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
  ed.insertText(${FIBER_TEXT_TOKEN});
  return { ok: true };
})()
`;

export const FIBER_ENTER_JS = `
(async () => {
  const cb = window.__dfV.onEnter();
  if (!cb) return { err: 'no onEnter' };
  try { await cb(); return { called: true }; }
  catch (e) { return { called: false, error: String(e).slice(0, 250) }; }
})()
`;

export const FIBER_COMPOSER_TEXT_JS = `
(() => {
  const api = window.__dfV;
  const input = api && api.input && api.input();
  const ed = api && api.editor && api.editor();
  const dom = input ? String(input.textContent || '') : '';
  let model = '';
  try { if (ed) model = JSON.stringify(ed.children); } catch (e) {}
  return { dom, model };
})()
`;

export function fiberInsertExpression(text: string): string {
  return `${FIBER_HELPERS_JS};\n${FIBER_INSERT_JS.split(FIBER_TEXT_TOKEN).join(JSON.stringify(text))}`;
}

export function composerStillContains(snapshot: unknown, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed)
    return false;
  if (typeof snapshot === 'string')
    return snapshot.includes(trimmed);
  if (!snapshot || typeof snapshot !== 'object')
    return false;
  const rec = snapshot as { dom?: unknown; model?: unknown };
  const dom = typeof rec.dom === 'string' ? rec.dom : '';
  const model = typeof rec.model === 'string' ? rec.model : '';
  return dom.includes(trimmed) || model.includes(trimmed);
}

export function interpretFiberSendResult(args: {
  inserted: { ok?: boolean; err?: string } | null;
  entered: { called?: boolean; err?: string; error?: string } | null;
  stillContains: boolean;
}): { ok: boolean; error?: string } {
  if (!args.inserted || args.inserted.err) {
    return { ok: false, error: args.inserted?.err ?? 'no editor' };
  }
  if (!args.entered || args.entered.err) {
    return { ok: false, error: args.entered?.err ?? 'no onEnter' };
  }
  if (args.entered.called === false) {
    return { ok: false, error: args.entered.error ?? 'onEnter returned early' };
  }
  if (args.stillContains) {
    return { ok: false, error: 'onEnter returned early' };
  }
  return { ok: true };
}
