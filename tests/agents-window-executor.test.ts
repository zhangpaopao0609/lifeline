import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { SelectorConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentsRunOnLocalJS, CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';

/**
 * Command branch when the Agents window (Cursor's global agent list) is home.
 * This pins "once window type splits, the project-window selectors/flow must not be used" —
 * page-side DOM details were measured by scripts/probes/probe-agents-window.ts.
 */

const selectors = { chatInput: { strategies: ['.aislash-editor-input'] } } as unknown as SelectorConfig;

function agentsExecutor(client: CdpClient): CommandExecutor {
  const executor = new CommandExecutor(selectors);
  executor.setClient(client);
  executor.setWindowKindProvider(() => 'agents');
  return executor;
}

describe('CommandExecutor.switchTab（agents 窗口）', () => {
  it('按（分组 + 标题 + 同名序号）点行，回读到的 id 作为结果返回', async () => {
    const expressions: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        return { ok: true, landedComposerId: 'c-target', tried: 2, via: 'agents' };
      },
    } as unknown as CdpClient;

    const result = await agentsExecutor(fakeClient).switchTab('cmd-1', 'Design plan discussion', undefined, {
      composerId: 'c-target',
      sameTitleIndex: 1,
      section: 'acme/demo-repo',
    });

    assert.equal(result.ok, true);
    assert.equal((result.data as { landedComposerId?: string }).landedComposerId, 'c-target');
    const expr = expressions[0];
    // Only accept Agents-window rows; group/title/index must all be sent into the page
    assert.match(expr, /glass-sidebar-agent-row/);
    assert.match(expr, /acme\/demo-repo/);
    assert.match(expr, /Design plan discussion/);
    assert.match(expr, /"wantIdx": 1|wantIdx = 1/);
    assert.equal(expr.includes('agent-sidebar-cell'), false, '不该用项目窗口的侧栏选择器');
  });

  it('点完落到别的 agent 时报错（不假成功）', async () => {
    const fakeClient = {
      isConnected: () => true,
      evaluate: async () => ({
        ok: false,
        error: '点了 X 但落到别的 agent（want c-1 got c-2）',
      }),
    } as unknown as CdpClient;

    const result = await agentsExecutor(fakeClient).switchTab('cmd-2', 'X', undefined, { composerId: 'c-1' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /c-2|别的 agent/);
  });

  it('行找不到时报 Tab not found（可被上层识别为「控件缺失」）', async () => {
    const fakeClient = {
      isConnected: () => true,
      evaluate: async () => ({ ok: false, error: 'Tab not found: 不存在的会话' }),
    } as unknown as CdpClient;

    const result = await agentsExecutor(fakeClient).switchTab('cmd-3', '不存在的会话');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /^Tab not found:/);
  });

  it('草稿行（占位 id）点到即成功，不要求回读到 id', async () => {
    const fakeClient = {
      isConnected: () => true,
      evaluate: async () => ({ ok: true, landedComposerId: '', tried: 1, via: 'agents' }),
    } as unknown as CdpClient;

    const result = await agentsExecutor(fakeClient).switchTab('cmd-4', 'New Agent', undefined, {
      composerId: 'tab-7',
      section: 'acme/demo-repo',
    });
    assert.equal(result.ok, true);
  });
});

describe('CommandExecutor.sendMessage（agents 窗口）', () => {
  function sendFake() {
    const typed: string[] = [];
    const keys: Array<{ key: string; modifiers?: number }> = [];
    const expressions: string[] = [];
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        if (expression.includes('isUnsafe')) {
          return { ok: true, info: 'DIV.ui-prompt-input-editor__input | sel=.ui-prompt-input-editor__input' };
        }
        if (expression.includes('currentText'))
          return false;
        if (expression.includes('Send message'))
          return true;
        return null;
      },
      typeText: async (text: string) => { typed.push(text); },
      pressKey: async (key: string, _code: string, _keyCode: number, modifiers?: number) => {
        keys.push({ key, modifiers });
      },
    } as unknown as CdpClient;
    return { client, typed, keys, expressions };
  }

  it('聚焦 tiptap 输入框、全选用 Meta、点 Send message 按钮提交', async () => {
    const { client, typed, keys, expressions } = sendFake();
    const result = await agentsExecutor(client).sendMessage('cmd-send', '继续');

    assert.equal(result.ok, true);
    assert.deepEqual(typed, ['继续']);
    const focusExpr = expressions.find(e => e.includes('isUnsafe')) ?? '';
    assert.match(focusExpr, /ui-prompt-input-editor__input/);
    assert.equal(focusExpr.includes('aislash-editor-input'), false, 'agents 窗口不该用项目窗口的输入框选择器');
    // Select-all modifier: macOS uses Meta(4) (in tiptap, Ctrl+A only moves to line start)
    const selectAll = keys.find(k => k.key === 'a');
    assert.equal(selectAll?.modifiers, process.platform === 'darwin' ? 4 : 2);
    // Submit via the button, not Enter
    assert.ok(expressions.some(e => e.includes('Send message')));
    assert.equal(keys.some(k => k.key === 'Enter'), false);
  });

  it('输入框里已经就是这段文字（草稿）→ 不清空重打，直接提交', async () => {
    const typed: string[] = [];
    const keys: Array<{ key: string; modifiers?: number }> = [];
    const expressions: string[] = [];
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        if (expression.includes('isUnsafe')) {
          return {
            ok: true,
            info: 'DIV.ui-prompt-input-editor__input | sel=.ui-prompt-input-editor__input',
            currentText: '谢谢',
          };
        }
        if (expression.includes('Send message'))
          return true;
        return null;
      },
      typeText: async (text: string) => { typed.push(text); },
      pressKey: async (key: string, _code: string, _keyCode: number, modifiers?: number) => {
        keys.push({ key, modifiers });
      },
    } as unknown as CdpClient;

    const result = await agentsExecutor(client).sendMessage('cmd-draft', '谢谢');

    assert.equal(result.ok, true);
    // Draft text is "already typed in the IDE, only waiting to send": select-all + retype would wipe @file refs and is unnecessary
    assert.deepEqual(typed, []);
    assert.equal(keys.some(k => k.key === 'a' || k.key === 'Backspace'), false);
    assert.ok(expressions.some(e => e.includes('Send message')), '照样要提交');
  });
});

describe('CommandExecutor.newChat（agents 窗口）', () => {
  it('带 section 时点该小节的 New Agent，然后把运行位置扳到本机', async () => {
    const expressions: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        if (expression.includes('ui-select-trigger'))
          return { ok: true, before: 'Cloud', after: 'This Mac', changed: true };
        return { ok: true, via: 'section' };
      },
    } as unknown as CdpClient;

    const result = await agentsExecutor(fakeClient).newChat('cmd-new', { section: 'acme/demo-repo' });
    assert.equal(result.ok, true);
    assert.match(expressions[0], /New Agent/);
    assert.match(expressions[0], /acme\/demo-repo/);
    assert.match(expressions[expressions.length - 1], /ui-select-trigger/);
    assert.equal((result.data as { runOn?: string }).runOn, 'This Mac');
  });

  it('不带 section 时点侧栏顶部的 New Chat（primary action）', async () => {
    const expressions: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        if (expression.includes('ui-select-trigger'))
          return { ok: true, before: 'This Mac', after: 'This Mac', changed: false };
        return { ok: true, via: 'primary' };
      },
    } as unknown as CdpClient;

    const result = await agentsExecutor(fakeClient).newChat('cmd-new2');
    assert.equal(result.ok, true);
    assert.match(expressions[0], /data-action-id="new-agent"/);
  });
});

/**
 * 2026-09-17: clicking New Agent inside `No Repo` may default to `Run on: Cloud` (cloud agent, body unreadable) —
 * but **clicking New Agent itself does not create a cloud record** (the VM starts on the first message), so
 * flipping it to `This Mac` in the draft state is enough. Failure to flip must error: otherwise the user's
 * next send really creates a cloud agent.
 */
describe('agents 窗口新建：把 Run on 扳到 This Mac', () => {
  it('页面 JS 锁着选择器与三个选项的判据', () => {
    const js = agentsRunOnLocalJS();
    assert.match(js, /button\.ui-select-trigger/);
    assert.match(js, /role="menuitem"/);
    assert.match(js, /this mac/i);
    assert.match(js, /cloud/i);
  });

  it('已经是 This Mac：不改，也算成功', async () => {
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (expression.includes('ui-select-trigger'))
          return { ok: true, before: 'This Mac', after: 'This Mac', changed: false };
        return { ok: true, via: 'section' };
      },
    } as unknown as CdpClient;
    const result = await agentsExecutor(fakeClient).newChat('cmd-already', { section: 'No Repo' });
    assert.equal(result.ok, true);
  });

  it('扳不动（找不到开关 / 选项 / 没生效）→ 报错，且不重复点 New Agent', async () => {
    const expressions: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        if (expression.includes('ui-select-trigger'))
          return { ok: false, error: 'NO_LOCAL_OPTION', before: 'Cloud' };
        return { ok: true, via: 'section' };
      },
    } as unknown as CdpClient;
    const result = await agentsExecutor(fakeClient).newChat('cmd-fail', { section: 'No Repo' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /This Mac/);
    assert.match(result.error ?? '', /云 agent/);
    // The click happens only once (retry would create an extra draft); the second action is flipping the switch
    assert.equal(expressions.filter(e => e.includes('aria-label="New Agent"')).length, 1);
  });

  it('草稿还没渲染出开关：等一轮再试（NO_RUN_ON_CHIP 只重试一次）', async () => {
    // Count only **production JS** calls (including the NOT_APPLIED marker); the real-mouse fallback JS does not count
    let runOnCalls = 0;
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (!expression.includes('NOT_APPLIED')) {
          return expression.includes('ui-select-trigger') ? null : { ok: true, via: 'section' };
        }
        runOnCalls += 1;
        if (runOnCalls === 1)
          return { ok: false, error: 'NO_RUN_ON_CHIP' };
        return { ok: true, before: 'Cloud', after: 'This Mac', changed: true };
      },
    } as unknown as CdpClient;
    const result = await agentsExecutor(fakeClient).newChat('cmd-late', { section: 'No Repo' });
    assert.equal(result.ok, true);
    assert.equal(runOnCalls, 2, '第一轮失败后应该重试一次生产 JS');
  });
});
