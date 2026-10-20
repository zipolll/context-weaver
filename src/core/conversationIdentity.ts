import { conversationIdentity, platformConversation } from '../adapters/platforms';
import { mergeTurnHistory } from './history';
import type { AppState, Conversation, SourceSnapshot } from './types';

/** Operates on withWorkspace's clone. Only matching conversation identities merge. */
export function normalizeConversations(state: AppState): void {
  const groups = new Map<string, Conversation[]>(), redirects = new Map<string, string>();
  for (const conversation of state.conversations) {
    const identity = platformConversation(conversation.url);
    if (identity) Object.assign(conversation, identity);
    const key = conversationIdentity(conversation), group = groups.get(key) ?? [];
    group.push(conversation); groups.set(key, group);
  }
  state.conversations = [...groups.values()].map(group => {
    const oldest = [...group].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    if (group.length === 1) return oldest;
    const byUpdate = [...group].sort((a, b) => a.updatedAt - b.updatedAt), latest = byUpdate[byUpdate.length - 1]!;
    let turns = oldest.turns;
    for (const conversation of byUpdate) {
      if (conversation.id !== oldest.id) redirects.set(conversation.id, oldest.id);
      turns = mergeTurnHistory(turns, conversation.turns);
    }
    const custom = oldest.customTitle ? oldest : [...byUpdate].reverse().find(c => c.customTitle);
    return { ...oldest, turns, title: custom?.title ?? latest.title, customTitle: !!custom,
      sourceTitle: [...byUpdate].reverse().find(c => c.sourceTitle)?.sourceTitle ?? oldest.sourceTitle,
      url: latest.url, tags: [...new Set(group.flatMap(c => c.tags))], primaryTagId: oldest.primaryTagId ?? [...byUpdate].reverse().find(c => c.primaryTagId)?.primaryTagId, starred: group.some(c => c.starred), archived: group.every(c => c.archived),
      complete: group.some(c => c.complete), containerId: oldest.containerId ?? group.find(c => c.containerId)?.containerId ?? null,
      updatedAt: Math.max(...group.map(c => c.updatedAt)) };
  });
  const resolve = (id: string) => redirects.get(id) ?? id;
  const turnIds = new Map<string,string>();
  for (const conversation of state.conversations) for (const turn of conversation.turns) for (const id of [turn.id, ...turn.aliases ?? []]) turnIds.set(JSON.stringify([conversation.id,id]),turn.id);
  const resolveTurn = (conversationId: string, turnId: string) => turnIds.get(JSON.stringify([resolve(conversationId),turnId])) ?? turnId;
  const referencesChanged = redirects.size > 0 || state.conversations.some(c => c.turns.some(t => t.aliases?.length));
  for (const graph of state.graphs ?? []) {
    graph.conversationIds = [...new Set(graph.conversationIds.map(resolve))];
    graph.expanded = [...new Set(graph.expanded.map(resolve))];
    if (!referencesChanged) continue;
    const positions: typeof graph.positions = {};
    const keyFor = (key: string) => {
      if (redirects.has(key)) return resolve(key);
      try { const ref = JSON.parse(key); if (Array.isArray(ref) && ref.length === 2 && typeof ref[0] === 'string' && typeof ref[1] === 'string') return JSON.stringify([resolve(ref[0]), resolveTurn(ref[0],ref[1])]); } catch {}
      return key;
    };
    // Keep an existing survivor's placement; inherit the duplicate's if absent.
    for (const [key, position] of Object.entries(graph.positions)) if (keyFor(key) === key) positions[key] = position;
    for (const [key, position] of Object.entries(graph.positions)) positions[keyFor(key)] ??= position;
    graph.positions = positions;
  }
  if (!referencesChanged) return;
  const source = (snapshot: SourceSnapshot) => {
    if (!snapshot.conversationId) return;
    snapshot.conversationId = resolve(snapshot.conversationId);
    snapshot.turnIds = snapshot.turnIds.map(id => resolveTurn(snapshot.conversationId!,id));
    for (const turn of snapshot.turns ?? []) turn.id = resolveTurn(snapshot.conversationId,turn.id);
  };
  for (const relation of state.relations) { relation.targetId = resolve(relation.targetId); source(relation.source); }
  state.relations = state.relations.filter(relation => relation.targetId !== relation.source.conversationId);
  for (const draft of state.drafts) for (const snapshot of [...draft.sources, ...draft.editedSources ?? []]) source(snapshot);
  for (const snippet of state.snippets) if (snippet.conversationId) { snippet.conversationId = resolve(snippet.conversationId); if(snippet.turnId)snippet.turnId=resolveTurn(snippet.conversationId,snippet.turnId); }
  for (const item of state.staged ?? []) { source(item.source); if (item.node) { item.node.conversationId = resolve(item.node.conversationId); if(item.node.turnId)item.node.turnId=resolveTurn(item.node.conversationId,item.node.turnId); } }
  const questions = new Map<string, NonNullable<AppState['questionMeta']>[number]>();
  for (const meta of state.questionMeta ?? []) {
    meta.conversationId = resolve(meta.conversationId);
    meta.turnId = resolveTurn(meta.conversationId,meta.turnId);
    const key = JSON.stringify([meta.conversationId, meta.turnId]), old = questions.get(key);
    if (old) { old.tags = [...new Set([...old.tags, ...meta.tags])]; old.primaryTagId ??= meta.primaryTagId; } else questions.set(key, meta);
  }
  if (state.questionMeta) state.questionMeta = [...questions.values()];
}
