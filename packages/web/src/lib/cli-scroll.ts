/** Within this distance (px) of the bottom the CLI timeline counts as "at the bottom" and follows new output. */
export const CLI_STICK_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/**
 * Where the reader is: `follow` = close enough to keep pinning new output to the bottom;
 * `showJump` = far enough (more than one screen) that a "back to bottom" button is worth showing.
 */
export function cliScrollState(m: ScrollMetrics, stickPx = CLI_STICK_PX): { follow: boolean; showJump: boolean } {
  const distance = distanceFromBottom(m);
  return { follow: distance <= stickPx, showJump: distance > m.clientHeight };
}

/**
 * Elements appended at the tail since the previous render, for the new-message pill.
 * Only a tail append counts: the previous last element must still be present and no longer last.
 * A first sync (nothing before) or a wholesale replace (previous tail gone) is not "new messages".
 */
export function tailAppendCount(prevIds: readonly string[], nextIds: readonly string[]): number {
  const prevLast = prevIds[prevIds.length - 1];
  if (prevLast === undefined)
    return 0;
  const at = nextIds.lastIndexOf(prevLast);
  if (at < 0)
    return 0;
  return nextIds.length - 1 - at;
}
