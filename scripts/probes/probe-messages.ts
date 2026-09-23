// Throwaway probe: does Page.bringToFront un-throttle the chat list rendering?
// Counts message wrappers before/after bringing the target window to front.
import { WebSocket } from 'ws';

const CDP = 'http://127.0.0.1:9222';
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws: WebSocket, expression: string): Promise<unknown> {
  const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true });
  if (r?.exceptionDetails)
    throw new Error(r.exceptionDetails.text ?? 'eval failed');
  return r?.result?.value;
}

async function main(): Promise<void> {
  const res = await fetch(`${CDP}/json`);
  const targets = (await res.json()) as Array<{ type: string; title: string; url: string; webSocketDebuggerUrl?: string }>;
  /** Optional: filter by window title; if omitted, take the first page target. */
  const nameFilter = process.argv[2] ?? '';
  const target = targets.find(t => t.type === 'page' && t.title.includes(nameFilter));
  if (!target?.webSocketDebuggerUrl) {
    console.log(nameFilter ? `page target not found (title ~ ${nameFilter})` : 'no page target found');
    process.exit(1);
  }
  console.log('target:', target.title);

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

  const countExpr = `(() => {
    const aux = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar');
    const container = aux || document.body;
    const wrappers = container.querySelectorAll('[data-flat-index],[data-message-index],.composer-rendered-message[data-message-role],[data-message-role][data-message-id]').length;
    const visible = Array.from(container.querySelectorAll('[data-message-role]')).filter(e => e.offsetParent !== null).length;
    return JSON.stringify({ auxFound: !!aux, wrappers, visibleMessageRoles: visible, docHidden: document.hidden, visibility: document.visibilityState });
  })()`;

  console.log('BEFORE:', await evaluate(ws, countExpr));

  await send(ws, 'Page.bringToFront', {});
  console.log('bringToFront called, waiting 3s...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('AFTER: ', await evaluate(ws, countExpr));

  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
