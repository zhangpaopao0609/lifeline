import type { CliSessionClient } from '../../cli-session-manager.js';
import type { AcpClientOptions } from './types.js';
import { CodexClient } from '../codex/client.js';
import { AcpClient } from './client.js';

/** Keep lifecycle, synchronization and web controls shared across CLI protocols. */
export function createProviderClient(options: AcpClientOptions): CliSessionClient {
  return options.profile.source === 'codex-cli' ? new CodexClient(options) : new AcpClient(options);
}
