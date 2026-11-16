/**
 * Self-contained /register and /login pages (server-rendered, zero web-package dependency).
 * Submit via fetch. The page never interpolates the request's username, password, or next into HTML.
 * Errors are written with textContent.
 */

/**
 * Where `?next=` may send the browser. One function: the page embeds this source,
 * so the check the tests call and the check the browser runs cannot diverge.
 * Rejects a scheme-relative URL, a backslash, whitespace, and C0/C1 controls.
 */
export function safeNext(next: string): string {
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return '/';
  if (/[\s\\\u0000-\u001F\u007F-\u009F]/.test(next))
    return '/';
  return next;
}

const NEXT_HELPER = `
    function nextTarget() {
      var next = new URLSearchParams(location.search).get('next') || '/';
      return (${safeNext.toString()})(next);
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
    }
    .brand-name { font-weight: 640; letter-spacing: 0.14em; font-size: 13px; }
    .brand-dim { opacity: 0.45; }
    .brand-cursor {
      width: 7px; height: 13px; background: #fff; opacity: 0.8;
    }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; text-align: center; }
    .desc {
      margin: 10px 0 22px;
      font-size: 13px;
      line-height: 1.5;
      color: rgba(255,255,255,0.55);
      text-align: center;
    }
    form { display: flex; flex-direction: column; gap: 10px; }
    input {
      width: 100%;
      background: rgba(255,255,255,0.06);
      color: inherit;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 15px;
      outline: none;
    }
    input:focus { border-color: rgba(255,255,255,0.28); }
    button {
      margin-top: 6px;
      background: #fff;
      color: #000;
      border: 0;
      border-radius: 10px;
      font-size: 15px;
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
    .alt { margin-top: 16px; text-align: center; font-size: 13px; }
    .alt a { color: rgba(255,255,255,0.7); }
`;

function pageHtml(body: string, script: string, nonce: string): string {
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
  <script nonce="${nonce}">${script}</script>
</body>
</html>
`;
}

const SUBMIT = `
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      var err = document.getElementById('err');
      err.textContent = '';
      var username = document.getElementById('username').value;
      var password = document.getElementById('password').value;
      var extra = document.getElementById('confirm');
      var payload = extra
        ? { username: username, password: password, passwordConfirm: extra.value }
        : { username: username, password: password };
      try {
        var res = await fetch(extra ? '/api/register' : '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) { location.href = nextTarget(); return; }
        var data = await res.json().catch(function () { return {}; });
        err.textContent = data.error || '失败，请重试。';
      } catch (e) {
        err.textContent = '网络错误，请重试。';
      }
    });`;

export function securityHeaders(nonce: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      'default-src \'none\'',
      `script-src 'nonce-${nonce}'`,
      'style-src \'unsafe-inline\'',
      'img-src \'none\'',
      'connect-src \'self\'',
      'form-action \'none\'',
      'base-uri \'none\'',
      'frame-ancestors \'none\'',
    ].join('; '),
  };
}

export function loginPage(nonce: string, registrationOpen: boolean): string {
  const alt = registrationOpen
    ? '    <p class="alt"><a href="/register">注册账号</a></p>'
    : '';
  return pageHtml(
    `    <h1>登录</h1>
    <p class="desc">用你的用户名和密码进入控制台。</p>
    <form id="f">
      <input id="username" placeholder="用户名" autocomplete="username" spellcheck="false">
      <input id="password" type="password" placeholder="密码" autocomplete="current-password">
      <button type="submit">登录</button>
    </form>
    <p class="err" id="err"></p>
${alt}`,
    `${NEXT_HELPER}${SUBMIT}`,
    nonce,
  );
}

export function registerPage(nonce: string): string {
  return pageHtml(
    `    <h1>注册</h1>
    <p class="desc">用户名注册后不能修改。密码至少 12 位。</p>
    <form id="f">
      <input id="username" placeholder="用户名" autocomplete="username" spellcheck="false">
      <input id="password" type="password" placeholder="密码（至少 12 位）" autocomplete="new-password">
      <input id="confirm" type="password" placeholder="再输入一次密码" autocomplete="new-password">
      <button type="submit">注册并进入</button>
    </form>
    <p class="err" id="err"></p>
    <p class="alt"><a href="/login">已有账号，去登录</a></p>`,
    `${NEXT_HELPER}${SUBMIT}`,
    nonce,
  );
}
