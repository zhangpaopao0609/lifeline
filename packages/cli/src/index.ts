import { BUILD_VERSION as VERSION } from './build-version.js';
import { cmdDaemon } from './commands/daemon.js';
import { cmdOpen } from './commands/open.js';
import { cmdSetup } from './commands/setup.js';
import { cmdStart } from './commands/start.js';
import { cmdStatus } from './commands/status.js';
import { cmdUpdate } from './commands/update.js';
import { cliConfigPath } from './config.js';
import { cmdStop } from './daemon/stop.js';
import { log } from './ui.js';

const HELP = `Lifeline ${VERSION} — remote-control Cursor / CodeBuddy on your machine

Usage:
  lifeline setup --server-url <url>  Sign in via browser and start the agent
  lifeline setup                     Configure server URL + token (interactive)
  lifeline start               Run the agent in the foreground
  lifeline daemon install      Install as a background daemon (launchd/systemd)
  lifeline daemon uninstall    Remove the background daemon
  lifeline daemon status       Show daemon state
  lifeline stop                Stop the daemon, keep it installed
  lifeline status              Health check: version, config, IDE CDP, server
  lifeline update              Update to the latest release (--force to reinstall)
  lifeline open                Open the web client in your browser
  lifeline config path         Print the config file location

Config lives at ~/.lifeline/config.json.`;

function parseServerUrlFlag(argv: string[]): string | undefined {
  return parseFlagValue(argv, '--server-url');
}

function parseCodeFlag(argv: string[]): string | undefined {
  return parseFlagValue(argv, '--code');
}

/** Both `--name value` and `--name=value` are accepted. */
function parseFlagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name && argv[i + 1])
      return argv[i + 1];
    if (a.startsWith(`${name}=`))
      return a.slice(name.length + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2);

  switch (cmd) {
    case 'setup':
      await cmdSetup(
        parseServerUrlFlag(process.argv.slice(3)),
        parseCodeFlag(process.argv.slice(3)),
      );
      break;
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      cmdStop();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'update':
      await cmdUpdate(process.argv.slice(3));
      break;
    case 'open':
      cmdOpen();
      break;
    case 'daemon': {
      // install once reported a false success (the launchd step failed while the exit code stayed 0),
      // so `install.sh && lifeline daemon install` "succeeded" with the agent down. A failure has to
      // reach the exit code, or scripts cannot stop the chain.
      const outcome = cmdDaemon(sub ?? 'status');
      if (outcome && !outcome.ok)
        process.exit(1);
      break;
    }
    case 'config':
      log(cliConfigPath());
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      log(HELP);
      break;
    case '--version':
    case '-v':
      log(VERSION);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[cli] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
