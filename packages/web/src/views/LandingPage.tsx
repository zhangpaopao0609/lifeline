import { ArrowRight, Broadcast, CaretDown, DeviceMobile, Heartbeat, SealCheck } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { CommandBlock } from '../components/CommandBlock';
import { installOsHint, OsSwitch } from '../components/OsSwitch';
import { useInstallOs } from '../lib/enroll-os';
import { CONSOLE_PATH } from '../lib/routes';
import { installCommand, setupCommand } from '../net/enroll';

/**
 * Landing page (`/`; opening the default domain is this). Copy is the locked three-layer: name Lifeline / subtitle "in your pocket" / slogan "give that time back".
 * Literals here are `Lifeline` (2026-09-16 experiment: not all-caps); the console is still `Lifeline`, see Rail.tsx.
 * The visual motif is one line: hero runs horizontally (this machine → phone), then drops vertically through each section.
 *
 * In-page anchors still use scrollIntoView, not `<a href="#…">`: hashing the URL pushes a history entry,
 * so back becomes "previous anchor" instead of leaving the landing page.
 */
const NAV = [
  ['what', '它解决什么'],
  ['how', '它怎么跑'],
  ['enroll', '把你装上'],
] as const;

const FEATURES = [
  {
    icon: <Heartbeat size={18} />,
    title: '会话不断',
    body: '网页上的内容来自本机磁盘里的会话文件，实时投影；不是另起一个云端会话。同一个会话从桌面延续到手机。',
  },
  {
    icon: <SealCheck size={18} />,
    title: '你说了算',
    body: '批准 / 拒绝、跑 / 跳过命令、发新 prompt、切模式与模型，都在浏览器里完成。人不在，话还算数。',
  },
  {
    icon: <DeviceMobile size={18} />,
    title: '装进口袋',
    body: 'Cursor 和 CodeBuddy 各占一个槽；家里一台、公司一台，切个名字就换现场。',
  },
];

// Naming in the middle section matches the CLI: the user has two commands (`lifeline setup` / `lifeline daemon`);
// the product's own word is daemon, not agent (that's an internal name in the launchd label).
const FLOW = [
  ['本机 IDE', 'Cursor / CodeBuddy，CDP 只连 127.0.0.1'],
  ['lifeline daemon', '装在那台电脑上的守护进程，主动出站，不需要公网入口'],
  ['server', '中继 + 静态页；手机浏览器打开就接上'],
] as const;

function scrollToId(id: string): void {
  const el = document.getElementById(id);
  if (!el)
    return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/**
 * The screen in the pocket: give the hero a concrete object instead of a pile of adjectives (decorative, hidden from screen readers).
 * Content follows the real UI order: session on top, pending cards stuck to the composer at the bottom (spec P2);
 * the whitespace in the middle is "there's still more to say" — screen ratio is `.phone-screen`.
 */
function PhoneMock() {
  return (
    <div className="phone" aria-hidden="true">
      <div className="phone-notch" />
      <div className="phone-screen">
        {/* Header matches the real device: top row is "machine · IDE" (the phone top-bar switcher; ⌄ opens to change machines),
            bottom row is "session + status" (like TargetBar: title left, status dot right). */}
        <div className="phone-head">
          <div className="phone-top">
            <CaretDown size={12} weight="bold" className="phone-caret" />
            <span className="mono truncate">Mac · Codebuddy</span>
          </div>
          <div className="phone-title">
            <span className="truncate">换窗后会话高亮不闪回</span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-normal text-[var(--text-secondary)]">
              <span className="dot live-dot-pulse bg-[var(--ok)]" />
              已连接
            </span>
          </div>
        </div>

        <div className="phone-body">
          <div className="phone-said">把 uninstall.sh 也一起过一遍</div>

          <p className="mt-2.5 text-[12px] leading-[1.65] text-[var(--text-secondary)]">
            三处品牌串已经改完，剩下
            {' '}
            <span className="mono">install.sh</span>
            {' '}
            里的路径还没动手。
          </p>

          <div className="phone-tools mono">
            <CaretDown size={10} />
            2 个工具调用
          </div>

          <p className="mt-2.5 text-[12px] leading-[1.65] text-[var(--text-secondary)]">
            两处路径都改到了。跑一遍测试确认没漏？
          </p>

          <div className="phone-plan">
            <div className="phone-plan-head">
              <span>进度 3 / 5</span>
              <span className="mono">品牌串</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill w-[60%]" />
            </div>
          </div>
        </div>

        <div className="phone-dock">
          <div className="rounded-[var(--radius-md)] border border-[var(--accent)] bg-[var(--accent-faint)] p-2.5">
            <div className="text-[11px] text-[var(--accent)]">需要你批准</div>
            <div className="mono mt-1 text-[12px] text-[var(--text-secondary)]">npm test -- --filter 会话</div>
            <div className="phone-btns">
              <span className="phone-btn phone-btn-primary">批准</span>
              <span className="phone-btn phone-btn-ghost">跳过</span>
            </div>
          </div>
          <div className="phone-input">发一条指令…</div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  const installOs = useInstallOs();
  return (
    <div className="landing h-full overflow-y-auto">
      <nav className="landing-nav">
        <div className="landing-col flex items-center gap-2">
          <button type="button" className="brand-mark" onClick={() => scrollToId('top')}>
            <Broadcast size={18} color="var(--accent)" />
            Lifeline
          </button>
          <div className="flex-1" />
          <div className="hidden items-center gap-0.5 lg:flex">
            {NAV.map(([id, label]) => (
              <button key={id} type="button" className="landing-navlink" onClick={() => scrollToId(id)}>
                {label}
              </button>
            ))}
          </div>
          <Link to={CONSOLE_PATH} className="btn btn-primary min-h-11 lg:min-h-8">
            开始使用
          </Link>
        </div>
      </nav>

      <header id="top" className="landing-hero">
        <div className="landing-col grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center lg:gap-14">
          <div>
            <div className="eyebrow">线不断，人就自由</div>
            <h1 className="landing-title">Lifeline</h1>
            <p className="landing-sub">把你的 CodeBuddy / Cursor 装进口袋</p>
            <h2 className="landing-slogan">把守在电脑前的时间，还给你。</h2>
            <p className="landing-note">人走，线不断；回来，现场还在。</p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link to={CONSOLE_PATH} className="btn btn-primary landing-cta">
                开始使用
                <ArrowRight size={16} weight="bold" />
              </Link>
              <button type="button" className="btn btn-ghost landing-cta" onClick={() => scrollToId('what')}>
                看它怎么跑
              </button>
            </div>

            <div className="mt-6 flex items-center gap-2 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
              <span className="dot live-dot-pulse bg-[var(--ok)]" />
              远端只做中继，代码和会话始终在你本机
            </div>
          </div>

          <PhoneMock />
        </div>

        <div className="landing-col mt-12">
          <div className="flex items-center gap-3">
            <span className="mono shrink-0 text-[length:var(--text-chrome)] text-[var(--text-weak)]">本机 IDE</span>
            <span className="hero-line flex-1">
              <span className="hero-line-dot" />
            </span>
            <span className="mono shrink-0 text-[length:var(--text-chrome)] text-[var(--text-weak)]">你的手机</span>
          </div>
        </div>
      </header>

      <div className="landing-col">
        <div className="landing-thread">
          <section id="what" className="landing-sec">
            <div className="landing-sec-head">
              <span className="mono landing-idx">01</span>
              <h2 className="landing-h2">把「守着」换成「走开」</h2>
            </div>
            <p className="landing-lead">它没有把你的开发搬到别的地方去，只是让你能从电脑前走开。</p>

            <div className="mt-6 grid gap-3 lg:grid-cols-2">
              <div className="landing-card">
                <div className="mono text-[11px] text-[var(--text-weak)]">以前</div>
                <p className="mt-2 text-[14.5px] leading-[1.7] text-[var(--text-secondary)]">
                  agent 干活要等，审批不来就卡住 —— 你一走，它停在原地。所以你哪儿也去不了。
                </p>
              </div>
              <div className="landing-card is-now">
                <div className="mono text-[11px] text-[var(--accent)]">现在</div>
                <p className="mt-2 text-[14.5px] leading-[1.7] text-[var(--text-primary)]">
                  会话在本机照常跑，要审批的推到口袋里的手机上。你回来，现场一点没变。
                </p>
              </div>
            </div>
          </section>

          <section id="cap" className="landing-sec">
            <div className="landing-sec-head">
              <span className="mono landing-idx">02</span>
              <h2 className="landing-h2">本质上，它控制的是你的 IDE</h2>
            </div>
            <p className="landing-lead">远程操控本机那个真实的 IDE。好处是：会话是连续的，不会断。</p>

            <div className="mt-6 grid gap-3 lg:grid-cols-3">
              {FEATURES.map(f => (
                <div key={f.title} className="landing-card with-icon">
                  <div className="landing-card-icon">{f.icon}</div>
                  <div>
                    <h3 className="landing-card-title">{f.title}</h3>
                    <p className="landing-card-body">{f.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section id="how" className="landing-sec">
            <div className="landing-sec-head">
              <span className="mono landing-idx">03</span>
              <h2 className="landing-h2">它怎么跑起来</h2>
            </div>
            <p className="landing-lead">守护进程从本机主动出站连上中继，本机不需要暴露公网；CDP 只连 loopback。</p>

            <div className="landing-flow mt-7">
              {FLOW.map(([name, desc]) => (
                <div key={name} className="landing-node">
                  <div className="landing-node-name">{name}</div>
                  <div className="landing-node-desc">{desc}</div>
                </div>
              ))}
            </div>
          </section>

          <section id="enroll" className="landing-sec">
            <div className="landing-sec-head">
              <span className="mono landing-idx">04</span>
              <h2 className="landing-h2">把你装上</h2>
            </div>
            <p className="landing-lead">在要被控制的那台电脑上跑这两条命令。接入不要求本机预装 Node。</p>

            <div className="mt-6 grid gap-3">
              <OsSwitch />
              <CommandBlock
                className="surface-card p-4"
                title="① 安装 CLI"
                cmd={installCommand(undefined, installOs)}
                hint={installOsHint(installOs)}
                reserveHint
              />
              <CommandBlock className="surface-card p-4" title="② 启动并登录" cmd={setupCommand()} />
            </div>

            <p className="mt-4 text-[length:var(--text-chrome)] leading-[1.7] text-[var(--text-weak)]">
              接入会写入 IDE 启动参数，需要完全退出 IDE 再打开一次；装好后这台电脑会自己出现在控制台里。
            </p>
          </section>
        </div>
      </div>

      <footer className="landing-footer">
        <div className="landing-col landing-footer-inner">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-bold tracking-wide">
              <Broadcast size={18} color="var(--accent)" />
              Lifeline
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">线不断，人就自由。</span>
              <Link to={CONSOLE_PATH} className="btn btn-ghost min-h-11 lg:min-h-8">
                开始使用
              </Link>
            </div>
          </div>
          <p className="mt-4 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
            把你的 CodeBuddy / Cursor 装进口袋 · 把守在电脑前的时间，还给你。
          </p>
        </div>
      </footer>
    </div>
  );
}
