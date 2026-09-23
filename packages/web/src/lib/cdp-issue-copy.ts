import type { CdpIssue } from '../net/protocol';

export type CdpIssueTone = 'wait' | 'warn' | 'info' | 'progress';

export function cdpIssueCopy(issue: CdpIssue, ideLabel: string): { tone: CdpIssueTone; text: string } {
  switch (issue.kind) {
    case 'no-listener':
      if (issue.relaunch === 'skipped-not-running') {
        return { tone: 'info', text: `${ideLabel} 没在运行，打开它即可` };
      }
      // Missing executable: the agent **deliberately neither exits nor relaunches** (exiting would leave it unable to come back).
      // Spell this out, or the user only sees "can't connect" with no actionable clue.
      if (issue.relaunch === 'skipped-no-exe') {
        return {
          tone: 'warn',
          text: `找不到 ${ideLabel} 的程序位置，无法自动重启。把它装到标准目录，或检查 App Paths 注册表`,
        };
      }
      if (issue.relaunch === 'relaunched' || issue.relaunch === 'skipped-warming-up') {
        return { tone: 'progress', text: `${ideLabel} 没有带调试参数启动，正在尝试自动重启它…` };
      }
      return { tone: 'info', text: `连不上 ${ideLabel} 的调试端口` };
    case 'not-cdp':
      if (issue.notCdpCause === 'foreign') {
        const who = issue.browser?.trim() || '别的程序';
        return { tone: 'warn', text: `端口 ${issue.port} 上是 ${who}，不是 ${ideLabel}` };
      }
      {
        const occupied = issue.occupant?.trim()
          ? `被 ${issue.occupant.trim()} 占着`
          : '被占着';
        return {
          tone: 'warn',
          text: `${issue.port} ${occupied}，lifeline 连不上 ${ideLabel}。关掉它，或换一个端口`,
        };
      }
    case 'no-window':
      return { tone: 'wait', text: `${ideLabel} 还没打开窗口` };
    case 'no-workbench':
      return { tone: 'info', text: `端口 ${issue.port} 上没找到可接入的 ${ideLabel} 窗口` };
    case 'attach-failed':
    case 'unknown':
      return { tone: 'info', text: issue.detail.trim() || issue.detail };
  }
}
