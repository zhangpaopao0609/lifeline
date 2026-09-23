import antfu from '@antfu/eslint-config';
import reactHooks from 'eslint-plugin-react-hooks';

export default antfu(
  {
    type: 'app',
    react: true,
    // Pinned: otherwise antfu's config detects an IDE terminal and quietly downgrades
    // rules to "warn", so `pnpm lint` would disagree with CI.
    isInEditor: false,
    // eslint-plugin-pnpm autofixes pnpm-workspace.yaml itself (appending
    // `shellEmulator` / `trustPolicy` / …). That file is hand-curated here, with its
    // rationale in comments, and those settings change install behaviour.
    pnpm: false,
    // Semicolons are the existing house style (every file already uses them). Drop
    // this line to adopt antfu's no-semicolon default, then re-run `pnpm lint:fix`.
    stylistic: { semi: true },
  },
  {
    // react-hooks is the canonical hooks lint — and the rule id the existing
    // `eslint-disable-next-line react-hooks/exhaustive-deps` comments point at.
    // @eslint-react (pulled in by `react: true`) ships a duplicate of it.
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/exhaustive-deps': 'off',
    },
  },
  {
    rules: {
      // antfu's groups sort `side-effect` imports (bare `import 'dotenv/config'`) AFTER
      // value imports, i.e. it moves them to the bottom of the block. A bare import
      // exists to run before everything else, so pin the group first — otherwise a
      // later-autoloaded module that reads `process.env` at import time silently breaks.
      // Everything else in this object is antfu's own groups config, unchanged.
      'perfectionist/sort-imports': ['error', {
        groups: [
          'side-effect',
          'type-import',
          ['type-parent', 'type-sibling', 'type-index', 'type-internal'],
          'value-builtin',
          'value-external',
          'value-internal',
          ['value-parent', 'value-sibling', 'value-index'],
          'ts-equals-import',
          'unknown',
        ],
        newlinesBetween: 'ignore',
        newlinesInside: 'ignore',
        order: 'asc',
        type: 'natural',
      }],
      // Tests run on node:test, and titles deliberately name things
      // (`CodeBuddy: …`, `AUTH_HEADER ….`, `CommandExecutor.switchTab`).
      'test/no-import-node-test': 'off',
      'test/prefer-lowercase-title': 'off',
      // `process` / `Buffer` are Node globals and every package already relies on that.
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      // `while ((m = re.exec(s)))` is a deliberate parser idiom; only unparenthesised
      // assignment in a condition is worth flagging.
      'no-cond-assign': ['error', 'except-parens'],
      // Stripping control characters (\x00-\x1f) from log/install output is deliberate.
      'no-control-regex': 'off',
      // `@param keys` on a destructured prop is the readable form.
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      // @stylistic's default (max: 1) rejects the one-line arrow bodies this codebase is
      // built from (`useEffect(() => { … }, [])`, `onClick={() => { … }}`, inline
      // `try`/`Promise` helpers) and the rule no longer takes `ignoredNodes`.
      'style/max-statements-per-line': 'off',
      // Same family: it wants the JSX ternary chain `{a ? <X/> : b ? <Y/> : <Z/>}` split
      // into one-token-per-line (and its fixer won't touch JSX, so `lint:fix` leaves it).
      'style/multiline-ternary': 'off',

      // Advisories, not blockers: real signals that need a human pass over code that
      // predates the linter. Fix opportunistically.
      'react/set-state-in-effect': 'warn',
      'react/naming-convention-ref-name': 'warn',
      'react/no-array-index-key': 'warn',
      'react/web-api-no-leaked-timeout': 'warn',
      'react/web-api-no-leaked-event-listener': 'warn',
      'react/purity': 'warn',
      'react/dom-no-dangerously-set-innerhtml': 'warn',
      'react-refresh/only-export-components': 'warn',
      'regexp/no-super-linear-backtracking': 'warn',
      'regexp/no-unused-capturing-group': 'warn',
      'ts/no-use-before-define': 'warn',
      'no-unmodified-loop-condition': 'warn',
    },
  },
  {
    // stdout is the product surface for the agent / server / CLI (and the install
    // hooks); the browser bundle is the one place a stray console.log should fail.
    files: ['packages/agent/src/**', 'packages/server/src/**', 'packages/cli/src/**', 'scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // The fake-CDP harnesses build functions on purpose.
    files: ['tests/**'],
    rules: { 'no-new-func': 'off' },
  },
);
