/** Body slice: only slice "the copy being sent out"; the mirror DB still holds the full body. */

import type { ChatElement } from '../types.js';
import { SESSION_PAGE_ITEMS } from '../../../protocol/src/index.js';

export interface SessionPage {
  messages: ChatElement[];
  hasMore: boolean;
  nextBefore?: number;
}

/**
 * Tail page: if it all fits, send the whole body (hasMore=false; caller ships it as authoritative full);
 * if not, slice the last limit items and set nextBefore to this page's first flatIndex — the client
 * sends that back as before next time.
 */
export function tailPage(
  messages: ChatElement[],
  limit = SESSION_PAGE_ITEMS,
): SessionPage {
  if (messages.length <= limit)
    return { messages, hasMore: false };
  const page = messages.slice(messages.length - limit);
  return { messages: page, hasMore: true, nextBefore: page[0].flatIndex };
}
