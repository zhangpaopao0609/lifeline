/**
 * Version of the current bundle. CLI and agent are the same bundle and both use this constant.
 *
 * `scripts/build-cli.ts` uses esbuild `define` to bake in `package.json`'s version
 * (single source of truth); plain `tsc` output and `tsx` (`pnpm run agent`) have no define, so typeof
 * falls back to a dev marker instead of throwing ReferenceError.
 */
declare const __CLI_VERSION__: string;

export const BUILD_VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';
