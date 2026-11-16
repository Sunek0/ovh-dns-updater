import type { EventFilter, StatusEvent } from '../types.js';

/** Shared event filter used by the store and the HTTP/SSE routes. */
export function matchesEventFilter(event: StatusEvent, filter: EventFilter): boolean {
  if (filter.account && event.accountId !== filter.account) return false;
  if (filter.domain && event.domain !== filter.domain) return false;
  if (filter.type && event.action !== filter.type) return false;
  return true;
}
