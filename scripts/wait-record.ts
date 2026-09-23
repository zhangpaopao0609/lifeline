/**
 * Blocks for a fixed duration so you can screen-record (e.g. the web UI).
 * Usage: pnpm exec tsx scripts/wait-record.ts
 *        pnpm exec tsx scripts/wait-record.ts 90   (custom seconds)
 */

const sec = Math.max(1, parseInt(process.argv[2] ?? '60', 10) || 60);

console.log('');
console.log(`[wait-record] ${sec}s window — record the web app, then continue when the timer ends.`);
console.log('[wait-record] Ctrl+C to stop early.');
console.log('');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let remaining = sec;
while (remaining > 0) {
  const chunk = Math.min(10, remaining);
  await sleep(chunk * 1000);
  remaining -= chunk;
  if (remaining > 0)
    console.log(`[wait-record] … ${remaining}s left`);
}

console.log('[wait-record] Done.');
process.exit(0);
