import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../packages/web/src/components/markdown.ts';

const LAST = 'Done: [Bind a card by email](https://docs.example.com/tools/detail?id=abc)\n\n- Form fields left: `email`, `password`\n';

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
