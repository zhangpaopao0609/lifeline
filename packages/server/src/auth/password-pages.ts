/**
 * Self-contained /claim and /login pages (server-rendered, zero web-package dependency); visual language
 * matches the 403 page. Submit via fetch to /api/claim, /api/login; success navigates to /.
 * Page content contains no internal names (release-scan grep gate).
 */

/**
 * Post-login / post-set-password bounce target: `?next=<original path>` from the 302 (e.g. CLI setup opening
 * /cli-setup?redirect_uri=...). Only same-origin relative paths are accepted — `//evil.com` / `/\evil.com`
 * would be treated by the browser as protocol-relative / normalized escapes; send those back to /.
 */
const NEXT_HELPER = `
    function nextTarget() {
      var next = new URLSearchParams(location.search).get('next') || '/';
      if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\\\')) return '/';
      return next;
    }`;

const STYLE = `
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
      padding: 32px 20px 12vh;
    }
    .card { width: min(100%, 380px); }
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
      text-align: center;
    }
    p.desc {
      font-size: 13px;
      line-height: 1.65;
      color: rgba(255,255,255,0.62);
      text-align: center;
      margin-bottom: 22px;
    }
    form { display: flex; flex-direction: column; gap: 10px; }
    input {
      width: 100%;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      color: rgba(255,255,255,0.94);
      font-size: 14px;
      padding: 11px 13px;
      outline: none;
    }
    input:focus { border-color: rgba(255,255,255,0.34); }
    input.code {
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 12px;
      letter-spacing: 0.06em;
    }
    button {
      width: 100%;
      background: #f2f2f2;
      color: #000;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      padding: 11px 0;
      cursor: pointer;
    }
    button:active { opacity: 0.85; }
    .err {
      min-height: 18px;
      margin-top: 12px;
      font-size: 12px;
      color: rgba(255,120,110,0.9);
      text-align: center;
    }
`;

function pageHtml(body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <meta name="theme-color" content="#000000">
  <title>Lifeline</title>
  <style>${STYLE}</style>
</head>
<body>
  <main class="card">
    <div class="brand" aria-hidden="true">
      <span class="brand-name">LIFE<span class="brand-dim">LINE</span></span>
      <span class="brand-cursor"></span>
    </div>
${body}
  </main>
  <script>${script}</script>
</body>
</html>
`;
}

export const CLAIM_HTML = pageHtml(
  `    <h1>设置密码</h1>
    <p class="desc">首次启动。服务器控制台打印了一串一次性引导码——复制它，在这里设置密码（至少 8 位）。</p>
    <form id="f">
      <input id="code" class="code" placeholder="一次性引导码" autocomplete="off" spellcheck="false">
      <input id="password" type="password" placeholder="密码（至少 8 位）" autocomplete="new-password">
      <button type="submit">保存并进入</button>
    </form>
    <p class="err" id="err"></p>`,
  `${NEXT_HELPER}
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      try {
        const res = await fetch('/api/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: document.getElementById('code').value.trim(),
            password: document.getElementById('password').value,
          }),
        });
        if (res.ok) { location.href = nextTarget(); return; }
        const data = await res.json().catch(() => ({}));
        err.textContent = data.error || '失败，请重试。';
      } catch {
        err.textContent = '网络错误，请重试。';
      }
    });`,
);

export const LOGIN_HTML = pageHtml(
  `    <h1>登录</h1>
    <p class="desc">输入密码进入控制台。连续失败会被暂时限流。</p>
    <form id="f">
      <input id="password" type="password" placeholder="密码" autocomplete="current-password">
      <button type="submit">登录</button>
    </form>
    <p class="err" id="err"></p>`,
  `${NEXT_HELPER}
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: document.getElementById('password').value }),
        });
        if (res.ok) { location.href = nextTarget(); return; }
        const data = await res.json().catch(() => ({}));
        err.textContent = data.error || '失败，请重试。';
      } catch {
        err.textContent = '网络错误，请重试。';
      }
    });`,
);
