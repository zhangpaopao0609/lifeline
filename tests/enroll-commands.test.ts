import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectInstallOs,
  machineCommandOs,
  setInstallOs,
  subscribeInstallOs,
} from '../packages/web/src/lib/enroll-os.js';
import {
  __setForceHttpCommandsForTest,
  installCommand,
  setupCommand,
  uninstallCommand,
  updateCommand,
} from '../packages/web/src/net/enroll.js';

const O = 'http://example.com';

describe('detectInstallOs', () => {
  it('detects Windows from the UA', () => {
    assert.equal(detectInstallOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  });

  // Unknown always falls to unix: we used to ship only unix commands, so a wrong guess is no worse
  it('treats macOS, Linux and unknown as unix', () => {
    assert.equal(detectInstallOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'unix');
    assert.equal(detectInstallOs('Mozilla/5.0 (X11; Linux x86_64)'), 'unix');
    assert.equal(detectInstallOs(''), 'unix');
    assert.equal(detectInstallOs(undefined), 'unix');
  });
});

describe('command builders', () => {
  it('builds the Windows commands', () => {
    assert.equal(installCommand(O, 'windows'), `irm ${O}/public/install.ps1 | iex`);
    assert.equal(uninstallCommand(O, 'windows'), `irm ${O}/public/uninstall.ps1 | iex`);
  });

  // PowerShell 5.1 has no `&&`; the Windows commands must chain with `;`
  it('never uses && in any Windows command', () => {
    for (const c of [installCommand(O, 'windows'), uninstallCommand(O, 'windows'), updateCommand(O, 'windows')]) {
      assert.doesNotMatch(c, /&&/, c);
    }
  });

  it('chains the Windows update with a semicolon', () => {
    assert.equal(updateCommand(O, 'windows'), `irm ${O}/public/install.ps1 | iex; lifeline daemon install`);
  });

  // Production app.js copy: not a single character may change
  it('keeps the unix commands byte-identical', () => {
    assert.equal(installCommand(O, 'unix'), `curl -fsSL ${O}/public/install.sh | sh`);
    assert.equal(uninstallCommand(O, 'unix'), `curl -fsSL ${O}/public/uninstall.sh | sh`);
    assert.equal(updateCommand(O, 'unix'), `curl -fsSL ${O}/public/install.sh | sh && lifeline daemon install`);
  });

  // https→http downgrade is a deployment-specific special case (origin listens on 80 only),
  // gated by VITE_FORCE_HTTP_COMMANDS: default keeps https commands; only a build that
  // turns the switch on downgrades.
  it('keeps https commands on https by default', () => {
    assert.equal(installCommand('https://x.example', 'unix'), 'curl -fsSL https://x.example/public/install.sh | sh');
    assert.equal(installCommand('https://x.example', 'windows'), 'irm https://x.example/public/install.ps1 | iex');
    assert.equal(setupCommand('https://x.example'), 'lifeline setup --server-url https://x.example');
  });

  it('downgrades https to http only when VITE_FORCE_HTTP_COMMANDS=1', () => {
    __setForceHttpCommandsForTest('1');
    try {
      assert.equal(installCommand('https://x.example', 'unix'), 'curl -fsSL http://x.example/public/install.sh | sh');
      assert.equal(installCommand('https://x.example', 'windows'), 'irm http://x.example/public/install.ps1 | iex');
    }
    finally {
      __setForceHttpCommandsForTest(undefined);
    }
  });

  it('defaults to the currently selected OS', () => {
    setInstallOs('windows');
    try {
      assert.equal(installCommand(O), `irm ${O}/public/install.ps1 | iex`);
    }
    finally {
      setInstallOs('unix');
    }
    assert.equal(installCommand(O), `curl -fsSL ${O}/public/install.sh | sh`);
  });

  it('keeps the setup command platform-independent', () => {
    assert.equal(setupCommand(O), `lifeline setup --server-url ${O}`);
  });
});

/**
 * Machine-level commands (uninstall/upgrade in the ⋯ menu for **that machine**) follow the OS
 * the machine reported — clicking "uninstall" on a Windows machine from a Mac must yield the
 * PowerShell command.
 */
describe('machineCommandOs', () => {
  it('maps the machine platform to the command flavour', () => {
    assert.equal(machineCommandOs('win32'), 'windows');
    assert.equal(machineCommandOs('darwin'), 'unix');
    assert.equal(machineCommandOs('linux'), 'unix');
  });

  it('falls back to the viewer switch only when the machine never reported one', () => {
    assert.equal(machineCommandOs(undefined), undefined, '老 agent 不报平台 → 调用方回落 OS 开关');
  });

  it('gives a Windows machine the PowerShell commands even from a macOS console', () => {
    const os = machineCommandOs('win32');
    assert.equal(uninstallCommand(O, os), `irm ${O}/public/uninstall.ps1 | iex`);
    assert.equal(updateCommand(O, os), `irm ${O}/public/install.ps1 | iex; lifeline daemon install`);
    assert.equal(installCommand(O, machineCommandOs('linux')), `curl -fsSL ${O}/public/install.sh | sh`);
  });
});

describe('install OS store', () => {
  it('notifies subscribers once per change, and stops after unsubscribe', () => {
    let calls = 0;
    const off = subscribeInstallOs(() => {
      calls += 1;
    });
    try {
      setInstallOs('windows');
      assert.equal(calls, 1);
      setInstallOs('windows');
      assert.equal(calls, 1, '同值不该再通知');
      off();
      setInstallOs('unix');
      assert.equal(calls, 1, '退订后不该再通知');
    }
    finally {
      off();
      setInstallOs('unix');
    }
  });
});
