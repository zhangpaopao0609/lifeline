import { openBrowser, requireConfig } from '../ui.js';

export function cmdOpen(): void {
  const config = requireConfig();
  openBrowser(config.serverUrl);
}
