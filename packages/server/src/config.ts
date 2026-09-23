import 'dotenv/config';
import type { ServerConfig } from './types.js';
import { resolve } from 'node:path';
import { createAuthProvider } from './auth/factory.js';

function envFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

export function loadConfig(): ServerConfig {
  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');

  const config: ServerConfig = {
    serverPort: parseInt(process.env.SERVER_PORT ?? '3000', 10),
    serverHost: process.env.SERVER_HOST ?? '127.0.0.1',
    logLevel: (process.env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    dataDir,
    authProviderName: process.env.AUTH_PROVIDER,
    authHeaderName: process.env.AUTH_HEADER,
    authPassword: process.env.AUTH_PASSWORD,
    authTrustedProxy: envFlag(process.env.AUTH_TRUSTED_PROXY),
    authAvatarUrl: process.env.AUTH_AVATAR_URL,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    authInsecureAllow: envFlag(process.env.AUTH_INSECURE_ALLOW),
  };
  // Assembly failures throw a specific error here (public-internet none, unknown name, missing AUTH_HEADER, …),
  // instead of the vague "Server requires ... token" in index.ts / Relay construction.
  config.authProvider = createAuthProvider(config);
  // fail-open compensation control: on loopback, "nothing configured" silently falls to none — this log lets
  // "provider is not the expected value" be caught by log alerts / liveness assertions.
  console.log(`[auth] provider=${config.authProvider.kind} (bind ${config.serverHost})`);
  return config;
}
