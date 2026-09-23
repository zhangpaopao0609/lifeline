/**
 * 403 page (self-contained: gated static assets are equally unreachable, so styles must be inlined).
 *
 * Shared by every provider (trusted-header / none / password). Copy must not name any deploy-specific
 * domain or login entry — that is each provider's job (`forbiddenHtml`).
 */
export const GENERIC_FORBIDDEN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <meta name="theme-color" content="#000000">
  <title>Lifeline</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: #000;
      color: rgba(255,255,255,0.94);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 20px 18vh;
    }
    .card { width: min(100%, 420px); text-align: center; }
    .brand {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-bottom: 28px;
      user-select: none;
    }
    .brand-name {
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.38em;
      text-indent: 0.38em;
    }
    .brand-dim { color: rgba(255,255,255,0.26); font-weight: 400; }
    .brand-cursor {
      width: 7px;
      height: 15px;
      background: #f2f2f2;
      animation: blink 1.1s steps(2, start) infinite;
    }
    @keyframes blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }
    h1 {
      font-size: 18px;
      font-weight: 560;
      letter-spacing: -0.02em;
      margin-bottom: 10px;
    }
    p {
      font-size: 13px;
      line-height: 1.65;
      color: rgba(255,255,255,0.62);
    }
    .hint {
      margin-top: 14px;
      font-size: 12px;
      color: rgba(255,255,255,0.42);
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand" aria-hidden="true">
      <span class="brand-name">LIFE<span class="brand-dim">LINE</span></span>
      <span class="brand-cursor"></span>
    </div>
    <h1>Sign-in required</h1>
    <p>This Lifeline server requires an authenticated session.</p>
    <p class="hint">Sign in through the gateway or login page that protects this deployment, then reload.</p>
  </main>
</body>
</html>
`;
