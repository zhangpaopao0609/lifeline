import type { IdeKind } from './types.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { registeredDrivers } from './drivers/index.js';

/**
 * Whether this machine can "control an IDE" (connect CDP, take over input, approvals).
 *
 * **On Linux we are a content source only**: read session data, no CDP, no input takeover.
 * That is a **product-scope** decision, not a probe result — so it depends only on
 * the platform, not on "whether a GUI IDE is installed on this machine".
 *
 * The criterion must be the platform, not a probe: the cost of a wrong call is
 * completely asymmetric — treating a working machine as a content source = the
 * user is fully blocked with no explanation; the reverse is just an extra row
 * in the machine list.
 *
 * `LIFELINE_LINUX_CDP=1` is an escape hatch: if we later need Linux control,
 * no code change is required.
 *
 * **Enumerate explicitly**; do not fall back to `platform !== 'linux'`: that
 * means "unknown platforms are allowed by default", so every new platform is a
 * silent allow; we have not verified what those platforms can actually do.
 */
const LIVE_CAPABLE: readonly NodeJS.Platform[] = ['darwin', 'win32'];

export function canControlIde(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (LIVE_CAPABLE.includes(platform))
    return true;
  if (platform === 'linux')
    return env.LIFELINE_LINUX_CDP === '1';
  return false;
}

/**
 * Which GUI IDEs are installed on this machine (**only meaningful on platforms
 * that can control an IDE**). Probe paths are declared on the driver (P3);
 * adding an IDE does not change this file.
 *
 * Used only to choose the **quiet strategy** — on connect failure, "report +
 * self-heal" vs "quiet slow poll".
 * **Never used to decide "can we connect"**: "app not found in the inventory"
 * is not "this machine has no such IDE"; Setapp / custom dirs / enterprise
 * installs all miss, and using that as a gate would keep the machine off CDP
 * entirely (review R1).
 */
export function detectLiveIdes(
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): IdeKind[] {
  const found: IdeKind[] = [];
  for (const { kind, driver } of registeredDrivers()) {
    if (driver.hasLiveApp(exists, home, platform, env))
      found.push(kind);
  }
  return found;
}
