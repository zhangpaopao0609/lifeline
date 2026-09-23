import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinPathArityViolations } from './ps1-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/web/public/uninstall.ps1');
const text = (): string => readFileSync(SCRIPT, 'utf-8');

// Same conventions as install.ps1: ASCII body, PS 5.1 compatible, do not pollute the caller session, no exit.
// On-machine e2e is planned Task 10 (run against the tree Task 9 installed).
describe('uninstall.ps1', () => {
  it('exists and is shipped by the web build', () => {
    assert.equal(existsSync(SCRIPT), true);
    // Source of truth has moved into FILES in `scripts/copy-web-public.ts` (the POSIX `cp` chain cannot run on Windows).
    const pkg = readFileSync(join(ROOT, 'packages/web/package.json'), 'utf-8');
    assert.match(pkg, /copy-web-public/, 'build 必须调用那个跨平台拷贝脚本');
    const copier = readFileSync(join(ROOT, 'scripts/copy-web-public.ts'), 'utf-8');
    assert.match(copier, /'uninstall\.ps1'/);
  });

  it('stops and unregisters the scheduled task', () => {
    const src = text();
    assert.match(src, /Stop-ScheduledTask/);
    assert.match(src, /Unregister-ScheduledTask/);
    assert.match(src, /Lifeline Agent/);
    assert.match(src, /pidfile|daemon\.pid/i, '没有计划任务时要退回 pidfile 进程');
  });

  // The only place force-kill is allowed: if the agent is stuck in teardown the process survives, and its runtime is about to be deleted
  it('recycles orphan lifeline.mjs processes (graceful first, then forced)', () => {
    const src = text();
    assert.match(src, /Win32_Process/);
    assert.match(src, /CommandLine/);
    assert.match(src, /lifeline\\?\.mjs/);
    assert.match(src, /Stop-Process/);
    assert.match(src, /-Force/);
  });

  it('strips the managed CDP argv from every IDE argv.json we may have written', () => {
    const src = text();
    assert.match(src, /Cursor[\\/]+argv\.json/);
    assert.match(src, /CodeBuddy CN[\\/]+argv\.json/);
    assert.match(src, /CodeBuddy[\\/]+argv\.json/);
    assert.match(src, /Lifeline CDP/, '只动我们写过的那几行');
  });

  // install.ps1 moves a locked .old to runtime.old.<stamp>; this must glob those away too
  it('cleans runtime.old* leftovers, not just the exact runtime.old', () => {
    const src = text();
    assert.match(src, /runtime\.old\*/);
  });

  it('removes the config home, the shim and the User PATH entry', () => {
    const src = text();
    assert.match(src, /\.lifeline/);
    assert.match(src, /lifeline\.cmd/);
    assert.match(src, /GetEnvironmentVariable\('Path',\s*'User'\)/);
    assert.match(src, /SetEnvironmentVariable\('Path'[^\n]*'User'\)/);
    assert.doesNotMatch(src, /SetEnvironmentVariable\([^)]*,\s*\$null\)/, '传 $null 是删变量');
    // Print PATH before and after the change so the user can check no other entries were touched.
    // **Must not** write `/PATH before|before/i` — that is equivalent to `/before/i`, and one
    // occurrence in a comment would pass.
    assert.match(src, /'PATH before'/);
    assert.match(src, /'PATH after'/);
  });

  it('removes an npm-global lifeline when npm is around, and reports leftovers', () => {
    const src = text();
    // Goes through `& $npm.Source uninstall -g lifeline`: resolve npm then invoke, so assert separately
    assert.match(src, /Get-Command npm/);
    assert.match(src, /uninstall -g lifeline/);
    // Teardown must report leftover lifeline on PATH (else the user thinks uninstall is complete / keeps being asked for a token)
    assert.match(src, /Get-Command lifeline/);
  });

  it('uses no exit, wraps everything in a function, and stays ASCII', () => {
    const src = text();
    assert.match(src, /^function\s+\S+\s*\{/m);
    assert.doesNotMatch(src, /^\s*exit\s/m, 'iex 里的 exit 会把用户的 PowerShell 窗口关掉');
    assert.doesNotMatch(src, /&&/, '5.1 没有 &&');
    assert.doesNotMatch(src, /[^\x00-\x7F]/, '必须纯 ASCII（install.ps1 头部有原因）');
    assert.deepEqual(joinPathArityViolations(src), [], '5.1 的 Join-Path 只吃两个位置参数');
  });

  it('does not contain any token or credential', () => {
    assert.doesNotMatch(text(), /AGENT_TOKEN|agentToken|Bearer /);
  });
});
