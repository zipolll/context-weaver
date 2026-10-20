import { conversationIdentity, platformConversation } from '../adapters/platforms';
import { uid } from './context';
import type { AppState, Conversation, SelectionSnapshot, SourceSnapshot } from './types';

export function sourceConversation(state: AppState, source: { url: string; conversationId?: string | null }): Conversation | undefined {
  const saved = source.conversationId && state.conversations.find(c => c.id === source.conversationId);
  if (saved) return saved;
  const identity = platformConversation(source.url), key = identity && JSON.stringify([identity.site, identity.externalId]);
  return state.conversations.find(c => key ? conversationIdentity(c) === key : c.url === source.url);
}
export function selectionSource(state: AppState, selection: SelectionSnapshot): SourceSnapshot {
  const conversation = sourceConversation(state, selection), turn = conversation?.turns.find(t => t.id === selection.turnId || t.aliases?.includes(selection.turnId ?? ''));
  return { id: uid(), conversationId: conversation?.id ?? null, title: selection.title, url: selection.url, turnIds: turn ? [turn.id] : selection.turnId ? [selection.turnId] : [], text: selection.text, capturedAt: Date.now() };
}
export function repairSourceReferences(state: AppState): void {
  const repair = (source: SourceSnapshot) => {
    const conversation = sourceConversation(state, source); if (!conversation) return;
    source.conversationId = conversation.id;
    const resolve = (id: string) => conversation.turns.find(turn => turn.id === id || turn.aliases?.includes(id))?.id ?? id;
    source.turnIds = source.turnIds.map(resolve);
    for (const turn of source.turns ?? []) turn.id = resolve(turn.id);
  };
  // Repair only missing references. Frozen source text, titles and URLs remain unchanged.
  for (const relation of state.relations) {
    const candidate = sourceConversation(state, relation.source); if (!candidate || candidate.id === relation.targetId) continue;
    if (candidate.id !== relation.source.conversationId) {
      const pending = [relation.targetId], visited = new Set<string>(); let cycle = false;
      while (pending.length) {
        const id = pending.pop()!; if (id === candidate.id) { cycle = true; break; }
        if (visited.has(id)) continue; visited.add(id);
        for (const edge of state.relations) if (edge.source.conversationId === id) pending.push(edge.targetId);
      }
      if (cycle) continue;
    }
    repair(relation.source);
  }
  for (const draft of state.drafts) for (const source of [...draft.sources, ...draft.editedSources ?? []]) repair(source);
  for (const item of state.staged ?? []) repair(item.source);
}
