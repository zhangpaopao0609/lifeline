/**
 * Version the console reports = `version` in the root `package.json` (same number as the CLI's
 * `__CLI_VERSION__`; there is only one source of truth).
 *
 * `vite.config.ts` bakes it into the bundle with `define` at build time. Contexts that skip Vite
 * (e.g. a module imported directly by a test) have no define, so `typeof` falls back to a dev
 * marker instead of throwing ReferenceError — same rule as `packages/cli/src/build-version.ts`.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
