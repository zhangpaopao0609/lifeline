/**
 * "What does the Agents window sidebar actually group by" — read-only; use **every** section to falsify one rule.
 *
 * Rule (measured 20/20 hits on 2026-09-17):
 *   Group = this agent's **local project**; three-level fallback
 *     ① Directory project (`glass.localAgentProjects.v1` workspace.id matches) → `workspace:<workspaceId>`
 *     ② Directory is the same repo, but identity landed on the repo → `repo:<url>` (measured 4/4 map to a local directory)
 *     ③ Neither → `home` (IDE shows `No Repo`)
 *
 * ③ is why `No Repo` is "partly cloud, partly local": it is **not a cloud-only group**, it is
 * the fallback bucket for "no local project identity" — cloud agents (project on a cloud VM) and "no-folder window" sessions
 * (no directory) both fail ①②, so they land here. See spec 3.6.
 *
 * Usage: pnpm exec tsx scripts/probes/probe-agents-section-rule.ts
 * Exit code: 0 = every section is explained by the rule; 2 = some section cannot be explained (the rule may have changed).
 */
import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CdpClient } from '../packages/agent/src/cdp/client.js';
import { loadConfig } from '../packages/agent/src/config.js';

interface CDPTarget { id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }
interface Project { name: string; workspaceId: string; fsPath: string }

const DB = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');

function localProjects(): Project[] {
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(p.value, '$.name'), '') AS name,
                COALESCE(json_extract(p.value, '$.workspace.id'), '') AS workspaceId,
                COALESCE(json_extract(p.value, '$.workspace.uri.fsPath'), '') AS fsPath
           FROM ItemTable AS t, json_each(t.value) AS p
          WHERE t.key = 'glass.localAgentProjects.v1'`,
      )
      .all() as Project[];
  }
  finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const projects = localProjects();
  const byWorkspaceId = new Map(projects.map(p => [p.workspaceId, p]));
  console.log(`本机项目（localAgentProjects）: ${projects.length} 个`);

  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) })).json()) as CDPTarget[];
  const page = targets.find(t => t.type === 'page' && t.title === 'Cursor Agents');
  if (!page?.webSocketDebuggerUrl) { console.error('[section-rule] 没找到 `Cursor Agents` 页'); process.exit(1); }

  const cdp = new CdpClient();
  await cdp.connect(page.webSocketDebuggerUrl);
  try {
    const sections = await cdp.evaluate(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('.ui-sidebar-section')).map((sec) => ({
        id: sec.getAttribute('data-agent-drop-section-id') || '',
        head: clean(sec.querySelector('[data-section-head] .ui-sidebar-menu-button-label')?.textContent),
        rows: Array.from(sec.querySelectorAll('.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]'))
          .map((r) => clean(r.querySelector('.ui-sidebar-menu-button-label')?.textContent)),
      }));
    })()`) as Array<{ id: string; head: string; rows: string[] }>;

    const unexplained: string[] = [];
    const count = { workspace: 0, repo: 0, home: 0 };
    for (const s of sections) {
      if (s.id.startsWith('workspace:home')) {
        count.home++;
        console.log(`[home] 「${s.head}」 ${s.rows.length} 行 → ${s.rows.join(' | ') || '(空)'}`);
        continue;
      }
      if (s.id.startsWith('workspace:')) {
        count.workspace++;
        const hit = byWorkspaceId.get(s.id.slice('workspace:'.length));
        console.log(`[workspace] 「${s.head}」 → ${hit ? `项目「${hit.name}」${hit.fsPath}` : '❓ 项目表里没有这个 workspaceId'}`);
        if (!hit)
          unexplained.push(`${s.id}（${s.head}）`);
        continue;
      }
      if (s.id.startsWith('repo:')) {
        count.repo++;
        const url = s.id.slice('repo:'.length);
        const basename = url.replace(/\.git$/, '').split('/').pop() ?? '';
        const hit = projects.find(p => basename && (p.fsPath.endsWith(`/${basename}`) || p.name.includes(basename)));
        console.log(`[repo] 「${s.head}」 → ${hit ? `项目「${hit.name}」${hit.fsPath}` : '❓ 项目表里找不到对应目录'}`);
        if (!hit)
          unexplained.push(`${s.id}（${s.head}）`);
        continue;
      }
      console.log(`[其他] ${s.id} 「${s.head}」 ${s.rows.length} 行`);
      unexplained.push(`${s.id}（${s.head}）`);
    }

    console.log(`\n小结：workspace ${count.workspace} / repo ${count.repo} / home ${count.home}`);
    if (unexplained.length) {
      console.error(`[section-rule] FAIL：规则解释不了 ${unexplained.join(' , ')}`);
      process.exit(2);
    }
    console.log('[section-rule] OK：全部小节都能被「没有本机项目身份就进 home」解释');
  }
  finally {
    cdp.disconnect();
  }
}

main().catch((err: unknown) => { console.error('[section-rule] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
