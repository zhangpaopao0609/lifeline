# 默认鉴权：用户名 + 密码

公网部署、又没有网关注入用户名时，默认登录是多人账号：自己注册用户名和密码，再登录。每个用户名是一个独立身份，只看自己 `lifeline setup` 登记的机器。

这是一套新的账号系统。不读取、不迁移、不承认旧的单一密码、claim 码、`AUTH_PASSWORD`，也不承认只写着 `owner`、库里却没有账号行的会话。

不发信，不使用验证码，不接入外部邮件服务。这版没有找回密码，也没有修改密码。

## 仍保持不变的部分

- 鉴权种类仍是 `password | trusted-header | none`。这次改的是 `password` 的行为，不新增种类。控制台文案仍是「密码登录」。
- `AUTH_HEADER` 仍然优先。有网关时继续认网关注入的用户名，不出现注册页。
- 只在本机回环地址上跑、且没有配 `AUTH_HEADER` 时，仍然可以不鉴权。公网和 `0.0.0.0` 不会落到无鉴权。
- 显式 `AUTH_PROVIDER=password` 使用这套账号。`AUTH_PROVIDER=none` 的原有限制不变。
- agent 仍用登记时发的机器令牌连接 `/agent-io`。浏览器账号和机器令牌分开。
- `/public/*`、`/healthz`、`/agent-io` 仍然不走浏览器登录。
- `/cli-setup` 仍然要先登录。签发的安装码绑的是当前用户名。`redirect_uri` 仍然只允许 `http://127.0.0.1/callback`（现有规则，不放宽）。
- WebSocket 的 Origin 规则不变：没有 Origin 的非浏览器客户端仍可连接。下面「登录请求必须带 Origin」只约束注册、登录和退出，不改这条。

## 启动条件

环境变量 `AUTH_PASSWORD` 只要非空，进程拒绝启动，错误写明这个变量已经不再使用。静默忽略会让操作者以为服务器有一把共享密码，实际却开着注册。

密码提供者绑在非回环地址上时（含容器里的 `0.0.0.0`），`PUBLIC_ORIGIN` 必须是 `https://` 开头、不含用户名密码、路径为空或 `/` 的源。否则拒绝启动。回环地址上的本地开发可以继续用 http。

`AUTH_REGISTRATION` 只有精确的字符串 `0` 表示关闭注册。不设、空字符串、`1` 或其他值都表示开放。启动时读一次，改完要重启。

没有账号且注册已关闭时，进程仍能启动，并在日志里写一条警告：现在谁都登不进去。

首启不打印 claim 码。

## 账号

用户名就是 `userId`，写进会话、`users`、`machines.owner_user_id` 和机器令牌。注册时定下来，这版不能改。

规则：

- 只做首尾去空白和 ASCII 小写。不做 NFKC，不把全角或其他 Unicode 折进合法字符。含非 ASCII 的直接拒绝。
- 长度 3 到 32。
- 必须匹配 `^[a-z0-9][a-z0-9._-]{2,31}$`。
- 不符合时 `POST /api/register` 返回 400，文案只说明格式。不创建账号，不把提交的用户名写进响应或 HTML。

密码：

- 原始字符串长度超过 128 时立刻返回 400，不运行 scrypt。
- 通过长度检查后再做 NFKC。规范化后短于 12、长于 128，或与规范化后的用户名相同，返回 400，不创建账号。
- 注册页要输入两次。两次不一致返回 400，不创建账号。
- 哈希是 scrypt，参数固定为 `N=131072, r=8, p=1`，盐 16 字节，输出 32 字节。参数写进哈希字符串。校验时只接受这一组参数和这两个长度；其他写法视为密码不匹配，且不按字符串里声明的更大 `N` 去计算。

登录失败一律返回 401，正文固定为用户名或密码不正确。不说明哪一项错了。用户名不存在时，仍用内置的同参数哑哈希走完一次 scrypt 和 `timingSafeEqual`，再返回同一个 401。成功和失败的响应都不带提交的用户名。

注册时用户名已被占用返回 409，文案固定为这个用户名已经有人使用。同时插入的竞争靠主键失败来落成 409，不把数据库错误原文返回给客户端。

## 注册开关

关闭之后：

- `GET /register` 返回 302 到 `/login`。
- `POST /api/register` 返回 403，正文固定，不透露该用户名是否存在。
- 已有账号照常登录。

开放时，`GET /register` 返回注册页。已登录访问 `/register` 或 `/login` 都 302 到 `/`。

## 页面与接口

页面仍由 server 渲染，不进 web 包。页面不把请求里的用户名、密码、`next` 插进 HTML。错误用脚本写入文本节点，不用 `innerHTML`。

鉴权门对以下路径精确放行，不区分方法。处理函数只实现列出的方法：

- `/register`（`GET` 返回页面）
- `/login`（`GET` 返回页面）
- `/api/register`（`POST` 注册）
- `/api/login`（`POST` 登录）

`/claim` 与 `/api/claim` 删除，不做重定向兼容。

未登录的页面 GET 一律 302 到 `/login?next=<原始路径>`，并带 `Cache-Control: no-store`。`next` 由页面脚本读取。解码后必须匹配以单个 `/` 开头的站内路径：拒绝 `//`、`/\`、反斜杠、控制字符和空白。不合法就去 `/`。服务器不对 `next` 发 302。

`POST /api/register` 的 JSON 体只有 `username`、`password`、`passwordConfirm` 三个字符串字段。成功时 `{ ok: true }` 并设置 cookie。

`POST /api/login` 的 JSON 体只有 `username`、`password` 两个字符串字段。成功时同样 `{ ok: true }` 并设置 cookie。cookie 里的 userId 是规范化之后的用户名。

两个接口都返回 JSON。跳转由页面脚本完成。

`POST /api/logout` 不在公开路径上。有效会话加上通过下面的来源检查后，把 cookie 清掉（`Max-Age=0`，其余标志与设置时相同）。没有会话时按未登录处理，不新发 cookie。

这三个 POST 的正文上限是 2048 字节。

注册页上的「去注册」链接只在注册开放时出现。

## 会话

签名密钥仍放在 `auth_local` 的单行里：首次使用时生成 32 字节随机数，之后不变。`auth_local.password_hash` 不再参与登录，也不用来生成账号。

cookie 名仍是 `lifeline_session`。值仍是 `v1|userId|过期时间|hmac`，hmac 覆盖前三段，比较用 `timingSafeEqual`。过期时间是签发后 14 天。

标志：`HttpOnly`、`SameSite=Strict`、`Path=/`。`PUBLIC_ORIGIN` 是 https，或本次请求的 `X-Forwarded-Proto` 是 https 时，加 `Secure`。`PUBLIC_ORIGIN` 已是 https 时，即使这次请求看起来是 http，也加 `Secure`。

每次 `verify` 除了验签名和过期，还要确认 `auth_accounts` 里有这个 `userId`。没有行就拒绝。因此旧的 `owner` cookie、已删除的账号、签名真但账号不存在的 cookie，都不能进入。

登录和注册成功都签发一张新 cookie，不沿用客户端带来的 cookie。

这版没有服务端会话表。退出只清掉当前浏览器的 cookie。已经复制走的 cookie 在过期前仍然有效。这是本版明确留下的界限，不是遗漏。

## 数据

新表 `auth_accounts`：

- `user_id TEXT PRIMARY KEY`：规范化后的用户名
- `password_hash TEXT NOT NULL`
- `created_at INTEGER NOT NULL`

写入和查询都用参数绑定。密码明文只存在于当次请求的内存里，不入库、不进日志、不进 cookie。

没有从旧密码到 `owner` 的迁移。空库就是空库，第一个人从注册页进来。

## 安全控制

这些控制针对的是：登录成功等于可以给这个身份登记机器，并远程操作那台机器上的 IDE。

**登录 CSRF。** 攻击者用自己的账号向受害者的浏览器提交登录，受害者随后执行 `lifeline setup`，机器会记到攻击者名下。`SameSite=Strict` 挡不住这件事，因为 cookie 是在跨站响应里种下的，之后受害者自己打开站点时会带上。因此 `POST /api/register`、`POST /api/login`、`POST /api/logout` 必须同时满足：

- `Content-Type` 的媒体类型是 `application/json`（可以带 `charset`）。否则 415，不设 cookie。
- 带有 `Origin`，且与现有的期望源一致（`PUBLIC_ORIGIN`，否则转发头，否则 `Host`）。缺少 Origin 或不相等时 403，不设 cookie。

浏览器对跨站表单不能发 `application/json`，跨站 `fetch` 的 Origin 对不上。本站页面的 `fetch` 两者都满足。这里故意比 WebSocket 更严：这两个接口不允许缺少 Origin。

**口令成本与拒绝服务。** 先卡 128 字符和 2048 字节正文，再做 scrypt。工作因子用 `N=131072`。限流按 IP，不按账号锁定：按账号锁定会让别人用错误密码把一个用户挡在外面。

**限流键。** 不打开 Fastify 的全局 `trustProxy`。只有同时满足这两点才采用 `X-Real-IP`：`AUTH_TRUSTED_PROXY=1`，且 TCP 对端是回环或私网地址（容器前面的本机 nginx 就是这种情况）。该值必须是单独一个 IP，不接受逗号分隔的列表。对端是公网地址时，只用对端地址，忽略客户端带来的转发头。标志没开、或 `X-Real-IP` 不合法时，用对端地址；在 nginx 后面这会变成整站共用一个桶。nginx 必须 `proxy_set_header X-Real-IP $remote_addr` 覆盖该头。容器端口只发布在 `127.0.0.1`，避免别人绕过 nginx 直连，并在标志打开时伪造限流键。

**额度。** 同一限流键每分钟最多 5 次失败，登录失败和注册失败共用。注册已关闭的 403 不计入。成功的登录不计入。注册请求另有每小时 30 次的上限（成功、400、409、密码错误都计入，403 不计入），同一键每小时最多成功注册 3 个账号。超过任一上限，`POST /api/register` 返回 429。

**用户名是否存在。** 登录接口不区分，也不靠响应时间区分。注册接口的 409 会说明名字已被占用，方便换名；试探速度由上面的每分钟失败额度和每小时 30 次注册额度卡住。页面和日志都不记录提交的用户名和密码。失败日志只记路径、结果和限流键。

**点击劫持与页面脚本。** 注册页和登录页响应带 `X-Frame-Options: DENY`，以及

`Content-Security-Policy: default-src 'none'; script-src 'nonce-<当次随机>'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`

`connect-src 'self'` 必须有，否则页面上的 `fetch` 会被 `default-src 'none'` 拦住。

样式是页面自带的，不插入用户输入，所以 `style-src` 允许内联。脚本只放行当次响应的 nonce。不引用外部脚本，不用表单提交。

**传输。** 非回环的密码登录必须配 https 的 `PUBLIC_ORIGIN`，见上文启动条件。文档里的 nginx 示例要发送 `Strict-Transport-Security`。TLS 在反代上终结，应用自己不监听 443。

**日志与库文件。** 不记录密码、哈希、cookie、会话密钥、注册或登录的正文。`./data` 里有会话密钥和密码哈希，备份和文件权限按机密处理。

## 工厂

组装顺序：显式 `AUTH_PROVIDER`，然后 `AUTH_HEADER`，然后回环地址上可以无鉴权，最后公网默认是这套密码账号。`AUTH_PASSWORD` 不再参与选择。

回环地址上要使用这套账号时，设置 `AUTH_PROVIDER=password`。

## 文档

改这些说明，使它们描述账号注册，并写明 https、`AUTH_REGISTRATION`、`X-Real-IP` 和 `AUTH_PASSWORD` 会拒绝启动：

- 根目录 `.env.example`
- `docs/selfhost.md` 与 `docs/zh-CN/selfhost.md`
- `README.md` 与 `README.zh-CN.md` 里关于自托管登录的那一句
- `scripts/selfhost.sh` 生成的 `.env` 注释

## 测试

- 注册合法用户名后，cookie 里的 userId 是小写用户名；该用户只能看见自己名下的机器。
- 非 ASCII、全角、格式不合法返回 400，且不创建账号。大小写不同视为同一个。重名返回 409。并发插入同一个名字时，一个成功，另一个 409，响应里没有数据库报错。
- 密码短于 12、长于 128、与用户名相同、两次不一致，都不创建账号。超过 128 时不调用 scrypt。
- 登录在用户不存在和密码错误时返回同一个 401。不存在的用户仍会走一次哑哈希校验。
- 哈希字符串里的 `N` 大于 131072 时不当作一次昂贵计算，直接视为密码不匹配。
- `AUTH_REGISTRATION=0` 时注册接口返回 403，已有账号仍能登录。响应不透露用户名是否存在。
- 缺少 Origin、Origin 不匹配、`Content-Type` 不是 JSON 时，注册和登录都不设置 cookie。
- `next` 为 `//evil.example`、`/\evil.example`、含反斜杠或控制字符时，页面目标是 `/`。
- cookie 含 `HttpOnly` 和 `SameSite=Strict`；`PUBLIC_ORIGIN` 为 https 时含 `Secure`。
- 签名正确但 `auth_accounts` 没有该用户时，`verify` 拒绝。
- 非回环地址且 `PUBLIC_ORIGIN` 不是 https 时，启动失败。`AUTH_PASSWORD` 非空时，启动失败。
- 对端是公网地址时，改变 `X-Forwarded-For` 或 `X-Real-IP` 不会换限流桶。对端是私网地址且 `AUTH_TRUSTED_PROXY=1` 时，单独一个合法的 `X-Real-IP` 才会换桶。
- 有 `AUTH_HEADER` 时不挂注册页。
- 未登录打开 `/cli-setup` 会到 `/login?next=...`。登录后会话里的用户名就是随后签发安装码的 owner。
- 失败日志夹具里不出现提交的密码。

## 不做

- 邮箱、验证码、发信、找回密码、修改密码、修改用户名、管理后台、邀请码。
- 不迁移旧密码，不创建 `owner`，不兼容 claim 码。
- 不提供服务端吊销。复制走的 cookie 在 14 天过期前仍然有效。
- 不改机器令牌、网关登录、无鉴权模式，以及 WebSocket 对「没有 Origin」的现有放行。
