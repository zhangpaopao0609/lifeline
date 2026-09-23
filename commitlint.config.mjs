/**
 * Commit-message rules. The written convention is in CONTRIBUTING.md
 * ("Commits and branches"); this file is what enforces it:
 *
 * - `rules`  → commitlint, run by the husky `commit-msg` hook.
 * - `prompt` → commitizen (cz-git), i.e. `pnpm commit`.
 *
 * The type list below feeds both, so they cannot drift apart.
 */
const TYPES = {
  feat: 'A new feature',
  fix: 'A bug fix',
  docs: 'Documentation only changes',
  refactor: 'A code change that neither fixes a bug nor adds a feature',
  test: 'Adding missing tests or correcting existing tests',
  chore: 'Other changes that don\'t modify src or test files',
};

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', Object.keys(TYPES)],
    // Not worth blocking a commit over: capitalised first words, long body
    // lines (URLs, Chinese), trailing punctuation.
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
  prompt: {
    types: Object.entries(TYPES).map(([value, name]) => ({ value, name: `${value}: ${name}` })),
    // Package names, mirroring how existing commits are scoped (`fix(agent): …`).
    scopes: ['agent', 'server', 'web', 'cli', 'protocol', 'deps', 'docs'],
    allowCustomScopes: true,
    allowEmptyScopes: true,
    useEmoji: false,
  },
};
