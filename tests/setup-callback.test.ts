import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setupCallbackHtml, startCallbackServer } from '../packages/cli/src/setup-callback.js';

describe('setupCallbackHtml', () => {
  it('asks the browser to close the tab', () => {
    assert.match(setupCallbackHtml(), /window\.close\s*\(/);
  });

  it('keeps a fallback if the browser refuses to close', () => {
    const html = setupCallbackHtml();
    assert.match(html, /关掉这个/);
    assert.match(html, /Lifeline/);
  });
});

describe('startCallbackServer', () => {
  it('releases the port after /callback even if the client keeps the socket', async () => {
    const { port, wait, closed } = await startCallbackServer();
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=tok`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /window\.close/);
    assert.equal(await wait, 'tok');
    await closed;
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/callback?code=x`, { signal: AbortSignal.timeout(400) }),
    );
  });
});
