import type { CliAcpCapability } from '@lifeline/protocol';
import { CLI_SOURCES } from '@lifeline/protocol';

/**
 * Static capability sent on `agent:register`.
 * Sources are the CLI kinds this build can speak, not whether a binary is installed.
 * `LIFELINE_LINUX_CDP` turns on IDE control for Linux. It does not add this field.
 */
export function staticCliAcp(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CliAcpCapability | undefined {
  void env.LIFELINE_LINUX_CDP;
  if (platform !== 'darwin')
    return undefined;
  return {
    protocolVersion: 1,
    platform: 'darwin',
    sources: CLI_SOURCES.map(source => ({ source })),
  };
}
