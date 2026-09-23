// Deep probe: dump per-wrapper attributes to see why extraction filters them out.
import { WebSocket } from 'ws';

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function main(): Promise<void> {
  const nameFilter = process.argv[2] ?? 'mp';
  const res = await fetch('http://127.0.0.1:9222/json');
  const targets = (await res.json()) as any[];
  const target = targets.find((t: any) => t.type === 'page' && t.title.includes(nameFilter));
  if (!target?.webSocketDebuggerUrl) { console.log('target not found:', nameFilter); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (data: unknown) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });

  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const expr = `(() => {
    const aux = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar');
    const container = aux || document.body;
    const wrappers = container.querySelectorAll('[data-flat-index],[data-message-index],.composer-rendered-message[data-message-role],[data-message-role][data-message-id]');
    const out = {
      containerIsAux: !!aux,
      containerTag: container.tagName + '.' + String(container.className).slice(0, 60),
      wrapperCount: wrappers.length,
      wrappers: Array.from(wrappers).slice(0, 10).map(w => {
        const msgEl = w.querySelector('[data-message-role]') || w;
        return {
          role: msgEl.getAttribute('data-message-role'),
          kind: msgEl.getAttribute('data-message-kind'),
          rowKind: msgEl.getAttribute('data-react-transcript-row-kind'),
          flatIndex: w.getAttribute('data-flat-index'),
          msgIndex: w.getAttribute('data-message-index'),
          hasLoadingIndicator: !!w.querySelector('.loading-indicator-v3'),
          textLen: (w.textContent || '').trim().length,
          textHead: (w.textContent || '').trim().slice(0, 50),
        };
      }),
    };
    return JSON.stringify(out, null, 1);
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r?.result?.value);
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
