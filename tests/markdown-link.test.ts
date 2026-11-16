import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../packages/web/src/components/markdown.ts';

const LAST = 'Done: [Bind a card by email](https://docs.example.com/tools/detail?id=abc)\n\n- Form fields left: `email`, `password`\n';

describe('code fence language label', () => {
  it('escapes the language tag before inserting it into the page', () => {
    const html = renderMarkdown('```<script>alert(1)</script>\nalert(1)\n```\n');
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /class="md-codeblock-lang">&lt;script&gt;alert\(1\)&lt;\/script&gt;</);
  });

  it('keeps an ordinary language name', () => {
    const html = renderMarkdown('```ts\nconst n = 1\n```\n');
    assert.match(html, /class="md-codeblock-lang">ts</);
  });
});

describe('assistant markdown links', () => {
  it('renders the final answer link as a favicon chip', () => {
    const html = renderMarkdown(LAST);
    assert.match(html, /Bind a card by email/);
    assert.match(html, /class="md-link-favicon"/);
    assert.match(html, /domain=example\.com&/);
    assert.match(html, /target="_blank"/);
    assert.equal(html.includes('<li>Form fields left: <code>email</code>'), true);
    assert.equal(html.includes('](https://'), false);
  });
});
