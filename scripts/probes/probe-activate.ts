// Probe 3: does browser-level Target.activateTarget raise the Electron window
// and materialize the virtualized chat list?
import { WebSocket } from 'ws';

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function attach(ws: WebSocket): void {
  ws.on('message', (data: unknown) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
}

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws: WebSocket, expression: string): Promise<unknown> {
  const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true });
  return r?.result?.value;
}

const COUNT_EXPR = `(() => {
  const aux = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar');
  const container = aux || document.body;
  const wrappers = container.querySelectorAll('[data-flat-index],[data-message-index],.composer-rendered-message[data-message-role],[data-message-role][data-message-id]').length;
  return JSON.stringify({ wrappers, visibility: document.visibilityState });
})()`;

async function main(): Promise<void> {
  /** Optional: filter by window title; if omitted, take the first page target. */
  const nameFilter = process.argv[2] ?? '';
  const matches = (title: string): boolean => title.includes(nameFilter);

  // Browser-level WS
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const version = (await versionRes.json()) as { webSocketDebuggerUrl: string };
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((r, j) => { browserWs.on('open', r); browserWs.on('error', j); });
  attach(browserWs);

  const { targetInfos } = await send(browserWs, 'Target.getTargets', {});
  const target = (targetInfos as any[]).find(t => t.type === 'page' && matches(t.title));
  if (!target) { console.log(nameFilter ? `page target not found (title ~ ${nameFilter})` : 'no page target found'); process.exit(1); }
  console.log('browser-level target:', target.targetId.slice(0, 12), target.title.slice(0, 40));

  // Page-level WS to measure
  const pagesRes = await fetch('http://127.0.0.1:9222/json');
  const pages = (await pagesRes.json()) as any[];
  const page = pages.find(p => matches(p.title));
  const pageWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((r, j) => { pageWs.on('open', r); pageWs.on('error', j); });
  attach(pageWs);

  console.log('BEFORE activateTarget:', await evaluate(pageWs, COUNT_EXPR));

  try {
    await send(browserWs, 'Target.activateTarget', { targetId: target.targetId });
    console.log('activateTarget OK');
  }
  catch (e: any) {
    console.log('activateTarget FAILED:', e.message);
  }

  await new Promise(r => setTimeout(r, 3000));
  console.log('AFTER activateTarget: ', await evaluate(pageWs, COUNT_EXPR));

  browserWs.close();
  pageWs.close();
  process.exit(0);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
