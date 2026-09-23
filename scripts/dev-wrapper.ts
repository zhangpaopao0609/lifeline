/**
 * Local debug: tsx watch runs a server-only process (MODE=server). For CDP, start `pnpm run agent` separately.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// pnpm also creates node_modules/.bin at the repo root (pointing at the real files under .pnpm); the path is unchanged.
const tsxPath = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
const child = spawn(tsxPath, ['watch', '--exclude', './data/**', '--exclude', './temp/**', 'packages/server/src/index.ts'], {
  stdio: 'inherit',
  cwd: process.cwd(),
});
child.on('error', (err) => {
  console.error('[dev-relay] Failed to start:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
