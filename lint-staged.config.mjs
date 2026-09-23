/**
 * Run from `pre-commit` (see `.husky/pre-commit`).
 *
 * Autofix only, and only over staged files: a hook must not alter behaviour, and
 * `pnpm lint` stays the full-repo gate. Extension list mirrors what the ESLint
 * config actually lints — anything else (Dockerfile, install.sh, .husky/*) is left alone.
 */
export default {
  '*.{js,mjs,cjs,ts,mts,cts,tsx,json,jsonc,yaml,yml,toml,md}': 'eslint --fix',
};
