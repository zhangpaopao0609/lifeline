/**
 * Poka-yoke for the two numbers in `package.json` (docs/release.md). Runs from the `pre-push` hook.
 *
 * The failure it must prevent (`cliVersion` is the only thing `/cli-latest.txt` publishes):
 *  - machine-side code changed since the last bump → the manifest does not move → every installed agent answers
 *    `isNewer(x, x) === false` → "already latest" and **never pulls the fix** (2026-10-05 war story);
 *  - the last bump shipped no machine-side change → every machine is asked to pull an identical build and the
 *    page badges 「可更新」 for nothing (2026-11-06).
 *
 * Best-effort by design: no git (shallow clone, Docker build context, exported tarball) or no reachable anchor
 * commit → say so and exit 0. A version check must never block a legitimate push.
 *
 * `git log -G`, not `-S`: a bump only changes the value, and `-S` counts occurrences of the string, so it would
 * never see the commit that bumped it.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directories whose content is published to machines (the artifact `cliVersion` names). */
export const MACHINE_SIDE_PATHS = ['packages/agent', 'packages/cli', 'packages/protocol'] as const;

export interface BumpCheckInput {
  /** Files under `MACHINE_SIDE_PATHS` changed after the last bump commit (`anchor..HEAD`). */
  machineSideSinceBump: string[];
  /** Did the bump commit itself touch machine-side code? `null` = the anchor has no parent. */
  bumpShippedMachineSide: boolean | null;
  /** The bump commit introduced the field (nothing to compare against) — the "noise" check does not apply. */
  introducedHere: boolean;
}

export interface BumpCheckVerdict {
  /** Blocking: the change can never reach a machine. */
  error?: string;
  /** Advisory: the bump is noise for every machine. */
  warning?: string;
}

/** Pure decision, so the two directions are testable without a git history. */
export function versionBumpVerdict(input: BumpCheckInput): BumpCheckVerdict {
  if (input.machineSideSinceBump.length > 0) {
    const shown = input.machineSideSinceBump.slice(0, 5).join('\n  ');
    const more = input.machineSideSinceBump.length > 5 ? `\n  … ${input.machineSideSinceBump.length - 5} more` : '';
    return {
      error: `machine-side code changed since the last cliVersion bump (${MACHINE_SIDE_PATHS.join(', ')}):\n  ${shown}${more}\n`
        + '  → bump package.json#cliVersion, or every installed agent stays on the old build forever\n'
        + '    (docs/release.md: /cli-latest.txt publishes exactly this number).',
    };
  }
  if (!input.introducedHere && input.bumpShippedMachineSide === false) {
    return {
      warning: 'the last cliVersion bump shipped no machine-side change — every machine will be asked to pull\n'
        + '  an identical build (and badges 「可更新」for nothing). A web-only change needs no bump.',
    };
  }
  return {};
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `null` = git cannot answer (no repo, shallow clone, unreachable commit). */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }
  catch {
    return null;
  }
}

function changedFiles(range: string): string[] | null {
  const out = git(['diff', '--name-only', range, '--', ...MACHINE_SIDE_PATHS]);
  if (out === null)
    return null;
  return out ? out.split('\n').filter(Boolean) : [];
}

function cliVersionOf(rev: string): { found: boolean; value?: string } {
  const raw = git(['show', `${rev}:package.json`]);
  if (raw === null)
    return { found: false };
  try {
    const pkg = JSON.parse(raw) as { cliVersion?: string };
    return { found: true, value: pkg.cliVersion };
  }
  catch {
    return { found: false };
  }
}

function main(): void {
  const tag = '[check-version-bump]';
  const anchor = git(['log', '-1', '--format=%H', '-G', '"cliVersion":', '--', 'package.json']);
  if (!anchor) {
    console.log(`${tag} no git history / no cliVersion commit here — skipped (docs/release.md).`);
    return;
  }

  const since = changedFiles(`${anchor}..HEAD`);
  if (since === null) {
    console.log(`${tag} cannot diff against ${anchor.slice(0, 7)} — skipped.`);
    return;
  }

  const parent = git(['rev-parse', '--verify', '--quiet', `${anchor}^`]);
  const anchorBump = parent ? changedFiles(`${parent}..${anchor}`) : null;
  const previous = parent ? cliVersionOf(parent) : { found: false };

  const verdict = versionBumpVerdict({
    machineSideSinceBump: since,
    bumpShippedMachineSide: anchorBump === null ? null : anchorBump.length > 0,
    introducedHere: !previous.value,
  });

  if (verdict.error) {
    console.error(`${tag} ${verdict.error}`);
    process.exit(1);
  }
  if (verdict.warning)
    console.warn(`${tag} ${verdict.warning}`);
  else
    console.log(`${tag} ok (last cliVersion bump ${anchor.slice(0, 7)}).`);
}

const isMain
  = typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain)
  main();
