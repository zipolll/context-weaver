import type { TurnLocation, TurnNavigationStatus } from '../core/types';
import { questionText } from '../core/turnLocation';
import type { SiteAdapter } from './types';

type Search = { id: string; started: number; stableSince: number; key?: string; element?: HTMLElement; original?: number; attempts: number; down: boolean; lastMove: number; atEdge: number; foundAt?: number; completed: boolean; failed: boolean };

/** One request owns scrolling; loaded but ambiguous questions never trigger a blind search. */
export function createTurnNavigator(adapter: SiteAdapter) {
  let search: Search | undefined;
  const move = (element: HTMLElement, top: number) => {
    const behavior = element.style.getPropertyValue('scroll-behavior'), priority = element.style.getPropertyPriority('scroll-behavior');
    element.style.setProperty('scroll-behavior', 'auto', 'important'); element.scrollTop = top;
    if (behavior) element.style.setProperty('scroll-behavior', behavior, priority); else element.style.removeProperty('scroll-behavior');
  };
  const restore = (current: Search) => { if (current.original !== undefined && current.element?.isConnected) move(current.element, current.original); };
  const navigate = (turnId: string, location?: TurnLocation, requestId?: string, verifyOnly = false): TurnNavigationStatus => {
    const now = Date.now(), id = requestId ?? 'direct:' + turnId;
    if (search?.id !== id) search = { id, started: now, stableSince: now, attempts: 0, down: false, lastMove: 0, atEdge: 0, completed: false, failed: false };
    if (search.completed) return 'found';
    try {
      // Instant alignment keeps hydration from racing a long smooth scroll. A
      // verification pass may retry matching, but must never start another search.
      if (adapter.locateTurn(turnId, location, 'instant')) { search.foundAt = now; return 'found'; }
      if (verifyOnly || !location || !requestId) return 'pending';
      const snapshot = adapter.readSnapshot();
      if (snapshot.site !== location.site || snapshot.externalId !== location.externalId) { search.original = undefined; return 'wrong-page'; }
      const key = JSON.stringify(snapshot.turns.map(turn => [turn.id, questionText(turn.user), turn.assistant.length]));
      if (key !== search.key) { search.key = key; search.stableSince = now; }
      const settling = now - search.started < 900 || now - search.stableSince < 600 || search.foundAt !== undefined && now - search.foundAt < 900;
      if (snapshot.turns.some(turn => questionText(turn.user) === questionText(location.user))) return settling ? 'pending' : 'ambiguous';
      if (settling) return 'pending';
      if (search.failed) return 'missing';
      const anchor = adapter.navigationAnchors()[0]?.element;
      if (!anchor) return 'pending';
      let element: HTMLElement | null = anchor.parentElement;
      while (element) {
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        if (element.scrollHeight > element.clientHeight + 8 && /auto|scroll/.test(style?.overflowY ?? '')) break;
        element = element.parentElement;
      }
      element ??= anchor.ownerDocument.scrollingElement as HTMLElement | null;
      if (!element || element.scrollHeight <= element.clientHeight + 8) return 'missing';
      if (search.element !== element) search.element = element;
      if (now - search.lastMove < 350) return 'pending';
      if (search.attempts >= 20) { restore(search); search.failed = true; return 'missing'; }
      search.original ??= element.scrollTop;
      const maximum = element.scrollHeight - element.clientHeight;
      const atEdge = search.down ? element.scrollTop >= maximum - 1 : element.scrollTop <= 1;
      search.atEdge = atEdge ? search.atEdge + 1 : 0;
      if (search.atEdge >= 2) {
        if (search.down) { restore(search); search.failed = true; return 'missing'; }
        search.down = true; search.atEdge = 0;
        move(element, Math.min(maximum, search.original));
      } else if (!atEdge) {
        // Question counts do not predict pixel offsets when answers have different
        // heights. Walk overlapping viewport ranges instead of jumping by index.
        move(element, Math.max(0, Math.min(maximum, element.scrollTop + (search.down ? 1 : -1) * element.clientHeight * 0.75)));
      }
      search.lastMove = now; search.attempts++;
    } catch { /* The page can replace its scroll container while loading. Retry with fresh DOM. */ }
    return 'pending';
  };
  navigate.finish = (requestId?: string) => { if (search && search.id === requestId) { search.completed = true; search.original = undefined; } };
  navigate.cancel = (requestId?: string, restorePosition = true) => {
    if (search && (!requestId || search.id === requestId)) { if (restorePosition && !search.completed) restore(search); search = undefined; }
  };
  return navigate;
}
