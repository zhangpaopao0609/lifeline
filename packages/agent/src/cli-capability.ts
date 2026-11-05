import type { CliAcpCapability } from '@lifeline/protocol';
import { CLI_SOURCES, isCliPlatform } from '@lifeline/protocol';

/**
 * Static capability sent on `agent:register`.
 * Sources are the CLI kinds this build can speak, not whether a binary is installed.
 * Declared on every platform that runs ACP CLI sessions (`CLI_PLATFORMS`: darwin, linux).
 * `LIFELINE_LINUX_CDP` turns on IDE control for Linux. It is unrelated to this field.
 */
export function staticCliAcp(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CliAcpCapability | undefined {
  void env.LIFELINE_LINUX_CDP;
  if (!isCliPlatform(platform))
    return undefined;
  return {
    protocolVersion: 1,
    platform,
    sources: CLI_SOURCES.map(source => ({ source })),
  };
}
