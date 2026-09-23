import type { ProbeResult } from '../packages/agent/src/cdp/probe.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearEndpointCache } from '../packages/agent/src/cdp/endpoint.js';
import {
  cdpQuitAndReopenHint,
  formatCdpStatusLine,
  formatContentSourceLine,
  probeStatusCdp,
} from '../packages/cli/src/cdp-status.js';

function probe(overrides: Partial<ProbeResult> & Pick<ProbeResult, 'kind'>): ProbeResult {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    detail: '',
    at: 1,
    ...overrides,
  };
}

describe('formatCdpStatusLine', () => {
  it('maps ok to workbench window count', () => {
    const line = formatCdpStatusLine(
      probe({ kind: 'ok', detail: '2 workbench', port: 52464 }),
      'active-port-file',
    );
    assert.equal(line, 'ok — 2 workbench window(s) via :52464 (active-port-file)');
  });

  it('maps no-window to waiting', () => {
    const line = formatCdpStatusLine(probe({ kind: 'no-window', port: 9223 }), 'config');
    assert.equal(line, 'waiting — no window open via :9223 (config)');
  });

  it('maps not-cdp to blocked and includes occupant when present', () => {
    const withOcc = formatCdpStatusLine(
      probe({ kind: 'not-cdp', occupant: 'Google Chrome (pid 65600)' }),
      'config',
    );
    assert.match(withOcc, /^blocked —/);
    assert.match(withOcc, /Google Chrome \(pid 65600\)/);
    assert.match(withOcc, /via :9222 \(config\)$/);

    const bare = formatCdpStatusLine(probe({ kind: 'not-cdp' }), 'config');
    assert.match(bare, /^blocked — port in use via :9222 \(config\)$/);
  });

  it('maps no-listener to down', () => {
    const line = formatCdpStatusLine(probe({ kind: 'no-listener' }), 'config');
    assert.equal(line, 'down — debug port not listening via :9222 (config)');
  });

  it('maps no-workbench, attach-failed, and unknown', () => {
    assert.equal(
      formatCdpStatusLine(probe({ kind: 'no-workbench' }), 'config'),
      'no-workbench — no attachable window via :9222 (config)',
    );
    assert.equal(
      formatCdpStatusLine(probe({ kind: 'attach-failed', detail: 'ws handshake refused' }), 'config'),
      'handshake-failed — ws handshake refused via :9222 (config)',
    );
    assert.equal(
      formatCdpStatusLine(probe({ kind: 'unknown', detail: 'fetch aborted' }), 'config-fallback'),
      'unknown — fetch aborted via :9222 (config-fallback)',
    );
  });
});

describe('formatContentSourceLine', () => {
  it('says it is a data source — and never claims "no GUI"', () => {
    const line = formatContentSourceLine();
    assert.match(line, /content source/);
    // The old "not found on the app list" wording called machines with a non-standard install path
    // "no GUI", and contradicted the agent (which is still probing).
    assert.doesNotMatch(line, /no GUI/i);
  });
});

describe('cdpQuitAndReopenHint', () => {
  it('only hints for no-listener, not-cdp, and unknown — not no-window', () => {
    for (const kind of ['no-listener', 'not-cdp', 'unknown'] as const) {
      assert.match(cdpQuitAndReopenHint(kind) ?? '', /lifeline will restart the IDE itself/);
    }
    for (const kind of ['ok', 'no-window', 'no-workbench', 'attach-failed'] as const) {
      assert.equal(cdpQuitAndReopenHint(kind), undefined);
    }
  });
});

describe('probeStatusCdp', () => {
  beforeEach(() => {
    clearEndpointCache();
  });

  it('probes the live DevToolsActivePort URL and reports that source', async () => {
    const liveUrl = 'http://127.0.0.1:52464';
    const probedUrls: string[] = [];
    const occupants: number[] = [];
    const { probed, source } = await probeStatusCdp({
      ide: 'cursor',
      configuredUrl: 'http://127.0.0.1:9222',
      candidates: ['/tmp/Cursor/DevToolsActivePort'],
      readFile: p => (p.endsWith('DevToolsActivePort') ? '52464\n/devtools/browser/x\n' : undefined),
      mtime: () => 1,
      lookupOccupant: (port) => {
        occupants.push(port);
        return undefined;
      },
      probe: async (url, _ide, opts) => {
        probedUrls.push(url);
        opts?.lookupOccupant?.(Number(new URL(url).port));
        const live = url === liveUrl;
        return {
          kind: live ? 'ok' : 'no-listener',
          cdpUrl: url,
          port: Number(new URL(url).port),
          detail: live ? '1 workbench' : '',
          at: 1,
        };
      },
    });
    assert.equal(probed.kind, 'ok');
    assert.equal(probed.cdpUrl, liveUrl);
    assert.equal(probed.port, 52464);
    assert.equal(source, 'active-port-file');
    assert.equal(probedUrls.includes('http://127.0.0.1:9222'), false);
    assert.deepEqual(occupants, [52464]);
  });
});
