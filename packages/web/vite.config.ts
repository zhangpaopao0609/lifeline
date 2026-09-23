import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Version source of truth = root `package.json` (same number as the CLI; see `__CLI_VERSION__`
 * in `scripts/build-cli.ts`). web is a separate subproject and cannot import across packages,
 * so it reads by path. If that fails, emit a dev marker — better to show "not a version" than to fail the build.
 */
function appVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  }
  catch {
    return '0.0.0-dev';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const relay = env.VITE_RELAY_URL || '(page origin)';
  return {
    // Absolute base: history mode downloads paths like `/console`; a relative path would resolve against the directory and break.
    base: '/',
    // Bake the version into the bundle at build time: source must not hard-code a version number (tests/web-version.test.ts watches this).
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    resolve: {
      alias: {
        '@lifeline/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'dev-banner',
        configureServer(server) {
          server.httpServer?.once('listening', () => {
            console.log(`\n  Lifeline UI  http://localhost:5173`);
            console.log(`  数据来自         ${relay}（已安装的本机 agent 不受影响）\n`);
          });
        },
      },
    ],
    build: {
      outDir: '../../dist/client',
      emptyOutDir: false,
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
