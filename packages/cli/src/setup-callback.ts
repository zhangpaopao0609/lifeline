import type { Server } from 'node:http';
import { createServer } from 'node:http';

export function setupCallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#000000">
  <title>已接入 · Lifeline</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; }
    html, body { height: 100%; }
    body {
      display: grid;
      place-items: center;
      background: #000;
      color: rgba(255, 255, 255, 0.94);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    main {
      width: min(24rem, calc(100vw - 3rem));
      padding: 1.75rem 1.75rem 1.5rem;
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 12px;
      background: #101010;
    }
    .mark {
      width: 1.75rem;
      height: 1.75rem;
      margin-bottom: 1rem;
      display: grid;
      place-items: center;
      border-radius: 999px;
      background: #3fb950;
      color: #0a0a0a;
    }
    h1 {
      font-size: 1.0625rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    p {
      margin-top: 0.5rem;
      font-size: 0.8125rem;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.62);
    }
    .brand {
      margin-top: 1.25rem;
      font-size: 0.6875rem;
      letter-spacing: 0.04em;
      color: rgba(255, 255, 255, 0.26);
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2.5 7.2l3 3.1 6-6.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h1>已经接到这台电脑</h1>
    <p>可以关掉这个标签，回到终端即可。</p>
    <div class="brand">Lifeline</div>
  </main>
  <script>
    window.close();
    try { window.open("", "_self"); window.close(); } catch (e) {}
  </script>
</body>
</html>`;
}

export function startCallbackServer(): Promise<{
  port: number;
  wait: Promise<string>;
  closed: Promise<void>;
}> {
  return new Promise((resolveListen, rejectListen) => {
    let settle: (code: string) => void;
    const wait = new Promise<string>((resolve) => {
      settle = resolve;
    });
    let resolveClosed: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'close',
      });
      res.end(setupCallbackHtml(), () => shutdown(server, resolveClosed));
      settle(code);
    });
    server.on('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveListen({ port, wait, closed });
    });
  });
}

function shutdown(server: Server, resolveClosed: () => void): void {
  server.close(() => resolveClosed());
  server.closeAllConnections();
}
