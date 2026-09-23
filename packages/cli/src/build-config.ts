/**
 * Default origin baked in at build time (fallback when install.sh has no readable config).
 *
 * `scripts/build-cli.ts` uses esbuild define to bake the `LIFELINE_DEFAULT_SERVER_URL` env var
 * in — self-hosted distros can bake their own origin; if the env is unset it becomes '',
 * in which case `lifeline status` skips the version check and `update` tells you to run setup first (no guessing the origin).
 * Pattern copied from build-version.ts: declare + typeof fallback so it also runs under plain tsc / tsx.
 */
declare const __CLI_DEFAULT_SERVER_URL__: string;

export const DEFAULT_SERVER_URL
  = typeof __CLI_DEFAULT_SERVER_URL__ === 'string' ? __CLI_DEFAULT_SERVER_URL__ : '';
