import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  isUnlimitedExecution,
  newLifelinePids,
  parseWindowsAgentPids,
  parseWindowsTaskStatus,
  pickOrphanLifelinePids,
  WINDOWS_DAEMON_TASK,
  windowsAgentProbePsCommand,
  windowsDaemonScript,
  windowsLifelinePidsPsCommand,
  windowsRegisterPsCommand,
  windowsStatusPsCommand,
  windowsStopPsCommand,
  windowsTaskAction,
  windowsUnregisterPsCommand,
  writeWindowsDaemonScript,
} from '../packages/cli/src/win-daemon.js';

const NODE = 'C:\\h\\.lifeline\\runtime\\node.exe';
const MJS = 'C:\\h\\.lifeline\\runtime\\lifeline.mjs';

describe('windowsDaemonScript', () => {
  const src = windowsDaemonScript(NODE, MJS);

  // The scheduled task restarts **only** when the action "failed to start"; once the process
  // is running, a later crash is ignored. So self-heal must come from the script's own
  // supervisor loop — that is T12's core conclusion.
  it('writes a supervisor loop instead of relying on RestartOnFailure', () => {
    assert.match(src, /while\s*\(\s*\$true\s*\)/);
    assert.match(src, /Start-Sleep/);
  });

  it('runs the agent and logs both streams to the log dir', () => {
    assert.match(src, /agent\.out\.log/);
    assert.match(src, /agent\.err\.log/);
    assert.match(src, new RegExp(MJS.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  });

  // Measured: 5.1 `>>` writes UTF-16LE with BOM (FF FE 68 00 …); cmd redirection is raw bytes.
  // UTF-16 logs disagree with launchd/systemd, and grep / the toolchain cannot read them.
  it('never uses a bare >> redirect (5.1 would write UTF-16LE)', () => {
    // The criterion must be exact: in `cmd /c "… 1>> `"$out`" …"` `$out` is quoted (expanded by cmd),
    // which is a different thing from "PowerShell pointing `>>` at a variable" — the latter is
    // the form that writes UTF-16LE.
    assert.match(src, /cmd\.exe \/c/);
    assert.match(src, /1>>/, '两条流必须分开重定向');
    assert.doesNotMatch(src, />\s*\$(out|err)\b/, '不许把重定向直接指向 PowerShell 变量（5.1 会写 UTF-16LE）');
  });

  // 5.1 `-File` parses BOM-less files as ANSI/GBK; comments are English, the body is ASCII.
  it('keeps the body ASCII (comments in English)', () => {
    assert.doesNotMatch(src, /[\u4E00-\u9FFF]/);
    assert.doesNotMatch(src, /[^\x00-\x7F]/, '正文必须纯 ASCII');
  });

  // Bad config (token rejected / server unreachable) makes the agent exit instantly; a fixed 5s is infinite restart + log explosion.
  it('backs off on repeated fast exits and resets after a healthy run', () => {
    // Assert the **real expression**: matching `$backoff` and `60` separately is tautological; swapping double and reset would still pass.
    assert.match(src, /\$backoff = \[Math\]::Min\(60, \$backoff \* 2\)/, '快退要翻倍、60s 封顶');
    assert.match(src, /\$backoff = 5/, '健康运行后要复位');
    assert.match(src, /Elapsed\.TotalSeconds -ge 60/, '复位条件是"跑满 60s"');
    // Wall clock can be fooled by NTP/DST jumps (rewind → negative; jump forward → instant exit counted as a healthy run)
    assert.doesNotMatch(src, /Get-Date/, '计时要用单调时钟');
  });

  // On-machine (2026-09-20): while the old agent is alive it **exclusively holds** `agent.out.log`, so
  // the supervisor's `cmd /c "… 1>> out"` fails the instant it opens the redirect — cmd exits
  // non-zero immediately, node is never launched, and the error bubbles to the supervisor
  // powershell's stderr, which under a scheduled task has **nowhere to go**.
  // Result: the agent never starts, logs have no trace at all (that is how "the web still says
  // updatable" happened). Instant-exit must be recorded in a file **the other agent does not hold**.
  it('records an almost-instant launch failure where it can be seen', () => {
    assert.match(src, /\$sup = Join-Path \$logDir 'supervisor\.log'/, '诊断要落到独立文件（out/err 正是被占的那两个）');
    assert.match(src, /\$LASTEXITCODE -ne 0/, '要读 cmd 的退出码 —— 重定向失败时 node 根本没跑');
    assert.match(src, /Elapsed\.TotalSeconds -lt 5/, '只记"秒退"（启动层失败），正常退出不记');
    assert.match(src, /cmd\.exe \/c "echo \[%DATE% %TIME%\]/, '由 cmd 写（5.1 的 >> 是 UTF-16LE）');
    assert.match(src, /1>> `"\$sup`"/, '诊断只能进 supervisor.log，不能指向被占的 out/err');
  });
});

describe('writeWindowsDaemonScript', () => {
  // The generated script contains **data** like <home>\runtime\node.exe, and a Chinese Windows
  // user dir may be C:\Users\<CJK name>\ — ASCII cannot hold that. 5.1 `-File` reads UTF-8 only if it sees a BOM.
  it('writes UTF-8 with a BOM so 5.1 reads non-ASCII paths correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-daemon-'));
    try {
      const file = join(dir, 'daemon.ps1');
      writeWindowsDaemonScript(file, NODE, MJS);
      const bytes = readFileSync(file);
      assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '必须带 UTF-8 BOM');
      assert.match(bytes.toString('utf-8'), /while\s*\(\s*\$true\s*\)/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a CJK path (the case that forced the BOM)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-daemon-'));
    try {
      const file = join(dir, 'daemon.ps1');
      const cjk = 'C:\\Users\\张三\\.lifeline\\runtime\\node.exe';
      writeWindowsDaemonScript(file, cjk, MJS);
      assert.equal(readFileSync(file, 'utf-8').includes(cjk), true);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('windowsTaskAction', () => {
  it('runs the supervisor hidden so the task stays Running without a console window', () => {
    const a = windowsTaskAction('C:\\h\\.lifeline\\daemon.ps1');
    assert.equal(a.execute, 'powershell.exe');
    assert.match(a.argument, /-WindowStyle Hidden/);
    assert.match(a.argument, /-File/);
    assert.match(a.argument, /daemon\.ps1/);
    assert.match(a.argument, /-NoProfile/);
  });
});

describe('windowsRegisterPsCommand', () => {
  const cmd = windowsRegisterPsCommand({ scriptPath: 'C:\\h\\.lifeline\\daemon.ps1' });

  it('registers an at-logon task with the least-privilege principal and no time limit', () => {
    assert.match(cmd, /New-ScheduledTaskTrigger -AtLogOn/);
    assert.match(cmd, /LogonType Interactive/);
    assert.match(cmd, /RunLevel Limited/);
    assert.doesNotMatch(cmd, /Highest/, 'Highest 是权限放大，不是"修 UIPI"');
    assert.match(cmd, /MultipleInstances IgnoreNew/);
    assert.match(cmd, /ExecutionTimeLimit \(New-TimeSpan -Seconds 0\)/);
    assert.match(cmd, /Register-ScheduledTask/);
  });

  // Measured (on machine): omitting `-UserId` makes the whole cmdlet report
  // `Cannot process command because of one or more missing mandatory parameters: UserId.`
  // so the task is **never registered**, while every other assertion still passes — pin this separately.
  it('passes the mandatory -UserId to New-ScheduledTaskPrincipal', () => {
    assert.match(cmd, /New-ScheduledTaskPrincipal -UserId/);
  });

  // AtLogOn only fires at the next logon; the end of `setup` relies on this to start the daemon immediately.
  it('starts it immediately (AtLogOn would not fire in this session)', () => {
    assert.match(cmd, /Start-ScheduledTask/);
  });

  // Both of these were disproven on a real machine: RestartInterval does not restart on non-zero
  // exit; -AtLogOn conflicts with the -RepetitionInterval parameter set (the task cannot even be created).
  it('does not use RestartInterval or RepetitionInterval', () => {
    assert.doesNotMatch(cmd, /RestartInterval/);
    assert.doesNotMatch(cmd, /RepetitionInterval/);
  });

  it('escapes single quotes in paths', () => {
    const one = windowsRegisterPsCommand({ scriptPath: 'C:\\a\'b\\daemon.ps1' });
    assert.match(one, /C:\\a''b\\daemon\.ps1/);
  });

  // ExecutionTimeLimit defaults to 72 hours — the agent vanishes after three days with no error.
  it('reads ExecutionTimeLimit back so the caller can flag a bad default', () => {
    const readback = windowsStatusPsCommand();
    assert.match(readback, /ExecutionTimeLimit/);
  });
});

describe('windowsStopPsCommand', () => {
  const cmd = windowsStopPsCommand();

  it('stops the task and sweeps leftover lifeline.mjs processes', () => {
    assert.match(cmd, /Stop-ScheduledTask/);
    assert.match(cmd, /lifeline\.mjs/);
  });

  // stop is "stop the daemon only", not uninstall: registration must stay, or the next `daemon install` cannot come up
  it('keeps the registration (that is what uninstall is for)', () => {
    assert.doesNotMatch(cmd, /Unregister-ScheduledTask/);
  });

  // Give it a chance to exit itself, then force-kill (`Stop-Process` then `-Force`)
  it('tries a graceful stop before forcing, with a wait in between', () => {
    const soft = cmd.indexOf('Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue');
    const force = cmd.indexOf('Stop-Process -Id $_.ProcessId -Force');
    assert.ok(soft >= 0, '缺少优雅停止');
    assert.ok(force >= 0, '缺少强杀');
    assert.ok(soft < force, '顺序必须是先优雅再强杀');
    assert.match(cmd.slice(soft, force), /Start-Sleep/, '两者之间要留时间');
  });

  // Real process tree is `powershell(-File daemon.ps1) → cmd.exe(redirect layer) → node.exe`;
  // **both cmd.exe and node.exe command lines contain lifeline.mjs**. A single scan still sees
  // node's parent (cmd) alive in the same snapshot → node escapes that round and becomes an
  // orphan. Must iterate to a fixed point.
  it('re-scans until no orphans remain instead of sweeping once', () => {
    assert.match(cmd, /while \(\$round -lt 5\)/);
    assert.match(cmd, /\$empty = \$empty \+ 1/);
  });

  // On-machine (full CLI path): after `stop` one node remains; **a second stop is what clears it**.
  // Root cause: `Stop-ScheduledTask` is **async** — sampling the moment it returns still has the
  // supervisor powershell in the table, so cmd/node both "have a live parent" and round 1
  // decides "no orphans" and breaks.
  // ⚠️ This assertion is about the **shape of the criterion**, not "whether that number is present".
  // First fix was `Start-Sleep -Milliseconds 800` — that only shrinks the race to a guessed
  // number of seconds, and still misses on a slow machine (review: changing the number still
  // passes, i.e. the same class of bug with a different number).
  // Correct shape is **wait for an observable condition**: the powershell whose command line
  // contains `daemon.ps1` disappears from the process table.
  it('waits for the supervisor process to disappear, not a guessed sleep', () => {
    assert.match(cmd, /while \(\$waited -lt 20\)/, '要有等待循环（超时上限）');
    assert.match(cmd, /daemon\.ps1/, '要按 daemon.ps1 认监管进程');
    assert.ok(
      cmd.indexOf('$waited') < cmd.indexOf('$orphans'),
      '必须先等监管消失，再开始扫孤儿（顺序反了就白等）',
    );
  });

  // This line was **hit on a real machine**: the statement's own command line contains
  // `daemon.ps1` (inside the `-like` literal), and it runs as `powershell -Command <stmt>`
  // → without excluding itself it self-matches forever and waits the full 10s
  // (measured: `stop` went from ~7.9s to ~20s). Re-review noted the guard had not pinned this.
  it('excludes its own process from the supervisor wait', () => {
    assert.match(cmd, /ProcessId -ne \$PID/, '不排除自己会永久自匹配');
  });

  // If the supervisor is still alive after timeout it **must be collected explicitly**: it is
  // not in the node/cmd candidate set, so the orphan scan never touches it; while it lives,
  // cmd/node both "have a live parent" → the orphan scan spins two empty rounds and quits.
  // Commenting this step without doing it is the same as giving up.
  it('kills a surviving supervisor when the wait times out', () => {
    assert.match(cmd, /if \(\$waited -ge 20\) \{/, '要有超时分支');
    const timeout = cmd.indexOf('if ($waited -ge 20)');
    assert.ok(timeout > cmd.indexOf('$orphans') || cmd.indexOf('Stop-Process -Id $_.ProcessId') > timeout, '超时分支里要用 Stop-Process 收监管');
    assert.match(cmd.slice(timeout), /Stop-Process -Id \$_.ProcessId -Force/, '超时分支要能强杀');
  });

  // `$live` must be the **full** PID set: a user-foreground `lifeline start` may have
  // WindowsTerminal.exe as parent; narrowing `$live` to "candidates only" misclassifies it
  // as an orphan → kills the user's foreground agent.
  it('builds the liveness set from every process, not just the candidates', () => {
    assert.match(cmd, /Get-Process -ErrorAction SilentlyContinue/, '全量 PID 用 Get-Process 取（快）');
    assert.match(cmd, /Name='node\.exe' OR Name='cmd\.exe'/, '候选集按名字收窄（避免全表取 CommandLine）');
    assert.ok(
      cmd.indexOf('foreach ($p in @(Get-Process') < cmd.indexOf('$orphans'),
      '先建全量活进程集，再算孤儿',
    );
  });

  it('only treats the tree as clean after two consecutive empty rounds', () => {
    assert.match(cmd, /if \(\$empty -ge 2\) \{ break \}/);
    assert.doesNotMatch(cmd, /\$orphans\.Count -eq 0\) \{ break \}/, '一轮空就 break 会输给异步竞态');
  });
});

describe('windowsUnregisterPsCommand', () => {
  const cmd = windowsUnregisterPsCommand();

  it('stops, sweeps, then unregisters without prompting', () => {
    assert.match(cmd, /Stop-ScheduledTask/);
    assert.match(cmd, /lifeline\.mjs/);
    assert.match(cmd, /Unregister-ScheduledTask/);
    assert.match(cmd, /-Confirm:\$false/);
  });
});

describe('parseWindowsTaskStatus', () => {
  it('reads State, LastTaskResult and ExecutionTimeLimit', () => {
    const r = parseWindowsTaskStatus('State=Running\nLastTaskResult=267009\nExecutionTimeLimit=00:00:00');
    assert.equal(r.state, 'Running');
    assert.equal(r.lastTaskResult, 267009, '不能只查 state —— 数字转换才是这里的真实逻辑');
    assert.equal(r.executionTimeLimit, '00:00:00');
  });

  // 267009 = 0x41301 = SCHED_S_TASK_RUNNING, meaning "running", not an error
  it('does not mistake 267009 for a failure', () => {
    assert.equal(parseWindowsTaskStatus('State=Running\nLastTaskResult=267009').running, true);
    assert.equal(parseWindowsTaskStatus('State=Ready\nLastTaskResult=0').running, false);
  });

  it('handles an empty table (task never registered)', () => {
    const r = parseWindowsTaskStatus('');
    assert.equal(r.state, undefined);
    assert.equal(r.running, false);
  });
});

// §11: `stop`/`restart` must only reclaim the copy **the daemon launched**. A user-foreground
// `node runtime\lifeline.mjs start` has an identical command line; cutting on CommandLine would kill it.
describe('pickOrphanLifelinePids', () => {
  const lifeline = 'node C:\\h\\.lifeline\\runtime\\lifeline.mjs start';

  it('picks a lifeline process whose parent is gone (the daemon case)', () => {
    // Daemon-launched: powershell(100) already killed by Stop-ScheduledTask → node is orphaned
    const snap = [
      { pid: 200, ppid: 100, commandLine: lifeline },
      { pid: 300, ppid: 1, commandLine: 'other.exe' },
    ];
    assert.deepEqual(pickOrphanLifelinePids(snap), [200]);
  });

  it('leaves a foreground lifeline alone (its shell is still alive)', () => {
    const snap = [
      { pid: 10, ppid: 1, commandLine: 'powershell.exe' },
      { pid: 200, ppid: 10, commandLine: lifeline },
    ];
    assert.deepEqual(pickOrphanLifelinePids(snap), []);
  });

  it('ignores non-lifeline processes and processes without a command line', () => {
    const snap = [
      { pid: 200, ppid: 999, commandLine: 'node C:\\other\\thing.mjs' },
      { pid: 201, ppid: 999, commandLine: undefined },
      { pid: 202, ppid: 999, commandLine: lifeline },
    ];
    assert.deepEqual(pickOrphanLifelinePids(snap), [202]);
  });

  it('treats ppid 0 as orphaned too', () => {
    assert.deepEqual(pickOrphanLifelinePids([{ pid: 5, ppid: 0, commandLine: lifeline }]), [5]);
  });

  // Must be synonymous with inline PowerShell `-like` (case-**insensitive**), or the two sides diverge
  it('matches the entry name case-insensitively, like PowerShell -like does', () => {
    const upper = 'node C:\\h\\.lifeline\\runtime\\LIFELINE.MJS start';
    assert.deepEqual(pickOrphanLifelinePids([{ pid: 7, ppid: 999, commandLine: upper }]), [7]);
  });
});

// Read-back check: task `Running` only means the **supervisor** is alive — the agent may fail at
// the launch layer every round (see the supervisor.log case above). So before install finishes,
// look at the **process-table** set difference.
//
// ⚠️ The criterion is only "node.exe + command line contains lifeline.mjs", and `lifeline daemon
// install` itself looks like that — **it always matches**. Treating "is there a match" as success
// is always-true (code-review on-machine: `node.exe ...lifeline.mjs daemon status` satisfied the
// probe by itself). So both defenses are required: (1) exclude the caller pid in the statement;
// (2) set-difference against "the set from before start" (leftover / foreground agents are not new).
describe('windowsAgentProbe', () => {
  it('the bare snapshot lists lifeline pids without waiting', () => {
    const bare = windowsLifelinePidsPsCommand();
    assert.doesNotMatch(bare, /Start-Sleep/, '"启动前那一份"不能白等');
    assert.match(bare, /Get-CimInstance Win32_Process/);
    assert.match(bare, /lifeline\.mjs/, '判据要与 stop 的孤儿回收认同一份命令行');
  });

  it('the probe waits first (it snapshots the "after" state)', () => {
    const cmd = windowsAgentProbePsCommand();
    assert.match(cmd, /Start-Sleep -Seconds 3/, 'agent 从 fork 到可见不是瞬时的，不能立刻断言');
    assert.match(cmd, /agent=/);
  });

  it('excludes the calling CLI by pid, since its own command line matches', () => {
    assert.match(windowsLifelinePidsPsCommand(4242), /ProcessId -ne 4242/);
    assert.doesNotMatch(windowsLifelinePidsPsCommand(), /ProcessId -ne/, '不传 pid 时不该凭空排除');
  });

  it('parses the pid list; anything unparseable counts as "none"', () => {
    assert.deepEqual(parseWindowsAgentPids('agent=1234,5678'), [1234, 5678]);
    assert.deepEqual(parseWindowsAgentPids('agent='), []);
    assert.deepEqual(parseWindowsAgentPids(''), [], '语句失败时宁可多提醒一次');
    assert.deepEqual(parseWindowsAgentPids('agent=oops'), []);
  });

  // Minimal repro of that always-true bug: the CLI itself (if not excluded) is in both snapshots — that is not a "new agent".
  it('diffs against the pre-install snapshot so the CLI cannot fake success', () => {
    const cli = 4242; // `lifeline daemon install` itself
    const foreground = 777; // user-foreground `lifeline start` (stop must not touch it)
    assert.deepEqual(newLifelinePids([cli, foreground], [cli, foreground, 9001]), [9001]);
    assert.deepEqual(newLifelinePids([cli], [cli]), [], '只有 CLI 自己 = agent 没起来');
    assert.deepEqual(newLifelinePids([cli], []), [], '一个都没剩下也说明没起来');
  });
});

describe('isUnlimitedExecution', () => {
  // Measured: this machine reads back ISO 8601 `PT0S`, while the schedule writes `00:00:00` — matching only the latter false-alarms every day
  it('accepts both spellings of zero', () => {
    assert.equal(isUnlimitedExecution('PT0S'), true);
    assert.equal(isUnlimitedExecution('00:00:00'), true);
  });

  // Review noted the whitelist was too narrow: zero-duration also includes PT0H / PT0M / P0D / 00:00:00.0000000.
  // Now it is "does the duration contain a non-zero digit", so these hold naturally.
  it('accepts every spelling of a zero duration', () => {
    // `0.00:00:00` is TimeSpan's c format (zero with a day field) — the counterexample from re-review; the first regex missed it
    for (const v of ['PT0S', 'PT0H', 'PT0M', 'P0D', '00:00:00', '00:00:00.0000000', '0.00:00:00', '0']) {
      assert.equal(isUnlimitedExecution(v), true, v);
    }
  });

  it('flags the 72-hour default and unknown/absent values', () => {
    for (const v of ['PT72H', 'PT1H', '00:00:01', '00:01:00', '1.00:00:00', undefined, '']) {
      assert.equal(isUnlimitedExecution(v), false, String(v));
    }
  });
});

describe('WINDOWS_DAEMON_TASK', () => {
  // uninstall.ps1 uses the same literal; if the two disagree the task can never be stopped
  it('is the same name uninstall.ps1 uses', () => {
    assert.equal(WINDOWS_DAEMON_TASK, 'Lifeline Agent');
    const ps1 = readFileSync(join(process.cwd(), 'packages/web/public/uninstall.ps1'), 'utf-8');
    assert.match(ps1, /Lifeline Agent/);
  });
});
