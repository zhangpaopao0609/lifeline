import MarkdownIt from 'markdown-it';

/**
 * Assistant message rendering: markdown-it, html:false (same as production; inline HTML is off to block injection).
 * Custom fence: language tag + copy-button placeholder (copy is taken over after MarkdownView mounts).
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

type RenderRule = NonNullable<typeof md.renderer.rules.fence>;

const defaultFence: RenderRule | undefined = md.renderer.rules.fence;

const fenceWithToolbar: RenderRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = (token.info || '').trim().split(/\s+/)[0] || '';
  const inner = defaultFence
    ? defaultFence(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  return (
    `<div class="md-codeblock">`
    + `<div class="md-codeblock-bar">`
    + `<span class="md-codeblock-lang">${lang || 'text'}</span>`
    + `<span class="md-codeblock-actions">`
    + `<button type="button" class="md-codeblock-expand">全屏</button>`
    + `<button type="button" class="md-codeblock-copy">复制</button>`
    + `</span>`
    + `</div>${
      inner
    }</div>`
  );
};

md.renderer.rules.fence = fenceWithToolbar;

/**
 * Table gets a scroll box of its own (`.md-table-wrap` in tokens.css): a table wider than the column must scroll
 * inside itself — left on its own it widens the transcript's scrollable width, which on the phone turns the session
 * into a two-axis scroller (hold and drag pans it sideways).
 */
const tableWrapOpen: RenderRule = (tokens, idx, options, _env, self) =>
  `<div class="md-table-wrap">${self.renderToken(tokens, idx, options)}`;

const tableWrapClose: RenderRule = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

md.renderer.rules.table_open = tableWrapOpen;
md.renderer.rules.table_close = tableWrapClose;

/**
 * Cursor draws http(s) links as an inline chip: a site favicon, then the label,
 * opening in a new tab. The icon is the same Google favicon service Cursor uses.
 */
const defaultLinkOpen: RenderRule = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

const MULTI_PART_SUFFIXES = new Set([
  'ac.uk',
  'co.il',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.uk',
  'co.za',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.mx',
  'com.sg',
  'com.tr',
  'com.tw',
  'gov.uk',
  'me.uk',
  'org.uk',
]);

/** Registrable domain Cursor asks the favicon service for (`docs.example.com` → `example.com`). */
function faviconDomain(hostname: string): string {
  const labels = hostname.split('.');
  if (labels.length <= 2)
    return hostname;
  const tail = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(tail) ? labels.slice(-3).join('.') : tail;
}

function linkFavicon(href: string): string {
  if (!/^https?:\/\//i.test(href))
    return '';
  let host = '';
  try {
    host = new URL(href).hostname.toLowerCase();
  }
  catch {
    return '';
  }
  if (!host || host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':'))
    return '';
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(faviconDomain(host))}&sz=64`;
  return `<img class="md-link-favicon" alt="" src="${src}" />`;
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = String(token.attrGet('href') ?? '');
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  const open = defaultLinkOpen(tokens, idx, options, env, self);
  const icon = linkFavicon(href);
  return icon ? `${open}${icon}` : open;
};

export function renderMarkdown(text: string): string {
  return md.render(text ?? '');
}
