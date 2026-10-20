import { uid } from './context';
import { normalizeConversations } from './conversationIdentity';
import { normalizeTags } from './tags';
import { repairSourceReferences } from './sources';
import type { AppCommand, AppState, KnowledgeGraph, NodeRef, TagEntry } from './types';

export const GRAPH_LAYOUT_VERSION = 2;
export const nodeKey = (ref: NodeRef) => ref.turnId ? JSON.stringify([ref.conversationId, ref.turnId]) : ref.conversationId;
export function newGraph(name = '我的知识图', folderId: string | null = null): KnowledgeGraph {
  return { id: uid(), name, folderId, conversationIds: [], positions: {}, expanded: [], createdAt: Date.now(), updatedAt: Date.now() };
}
// Additive migration: existing conversations, tags and source relations stay intact.
export function withWorkspace(input: AppState): AppState {
  const s = structuredClone(input);
  normalizeConversations(s);
  if (!s.graphs) s.graphs = [{ ...newGraph(), id: 'legacy-knowledge-graph', conversationIds: s.conversations.map(c => c.id) }];
  if (!s.graphs.length) s.graphs = [newGraph()];
  if (!s.graphs.some(g => g.id === s.activeGraphId)) s.activeGraphId = s.graphs[0]!.id;
  s.questionMeta ??= []; s.staged ??= []; s.tagEntries ??= []; s.openMode ??= 'split';
  // Earlier side panels could consume one context-menu action concurrently. Keep
  // the first record when loading old state so that those duplicates disappear.
  const seenStaged = new Set<string>();
  s.staged = s.staged.filter(item => {
    const identity = stagedIdentity(item.source, item.node);
    if (seenStaged.has(identity)) return false;
    seenStaged.add(identity);
    return true;
  });
  normalizeTags(s);
  repairSourceReferences(s);
  return s;
}
function stagedIdentity(source: { url: string; text: string; turnIds: string[] }, node?: NodeRef): string {
  return JSON.stringify([source.url, source.turnIds.length ? source.turnIds : node?.turnId ? [node.turnId] : [], source.text.replace(/\r\n?/g, '\n').trim()]);
}
export function nodeTags(s: AppState, ref: NodeRef): string[] {
  return ref.turnId ? s.questionMeta?.find(q => q.conversationId === ref.conversationId && q.turnId === ref.turnId)?.tags ?? [] : s.conversations.find(c => c.id === ref.conversationId)?.tags ?? [];
}
export function graphHasTag(s: AppState, g: KnowledgeGraph, tag: string): boolean {
  return g.conversationIds.some(id => s.conversations.find(c => c.id === id)?.tags.includes(tag) || s.questionMeta?.some(q => q.conversationId === id && q.tags.includes(tag)));
}
function checkTree(items: { id: string; parentId: string | null; kind?: string }[]) {
  for (const item of items) {
    const seen = new Set([item.id]); let parent = item.parentId;
    while (parent) { const p = items.find(t => t.id === parent); if (!p || p.kind === 'tag') throw new Error('目标文件夹不存在。'); if (seen.has(parent)) throw new Error('不能移动到自身或后代。'); seen.add(parent); parent = p.parentId; }
  }
}
function renameTag(s: AppState, from: string, into: string | null) {
  const update = (tags: string[]) => [...new Set(tags.flatMap(t => t === from ? into ? [into] : [] : [t]))];
  s.conversations.forEach(c => c.tags = update(c.tags)); s.questionMeta!.forEach(q => q.tags = update(q.tags));
}
export function workspaceCommand(input: AppState, command: AppCommand): AppState | null {
  const s = withWorkspace(input);
  switch (command.type) {
    case 'graph.patch': {
      const graph = s.graphs!.find(g => g.id === command.id); if (!graph) throw new Error('图不存在。');
      const patch = command.patch;
      const updated = workspaceCommand(s, { type: 'graph.save', graph: { ...graph, ...patch, positions: patch.positions ? { ...graph.positions, ...patch.positions } : graph.positions } })!;
      // A canvas settling after a graph switch must not reactivate the old graph.
      updated.activeGraphId = s.activeGraphId;
      return updated;
    }
    case 'graph.save': {
      const g = structuredClone(command.graph);
      if (!g.name.trim()) throw new Error('请输入图名称。');
      if (g.folderId && !s.containers.some(f => f.id === g.folderId)) throw new Error('目标文件夹不存在。');
      if (g.conversationIds.some(id => !s.conversations.some(c => c.id === id))) throw new Error('图中包含不存在的对话。');
      g.conversationIds = [...new Set(g.conversationIds)]; g.expanded = [...new Set(g.expanded)].filter(id => g.conversationIds.includes(id));
      g.name = g.name.trim().slice(0, 200); g.updatedAt = Date.now();
      s.graphs = [...s.graphs!.filter(x => x.id !== g.id), g]; s.activeGraphId = g.id; return s;
    }
    case 'graph.activate': if (!s.graphs!.some(g => g.id === command.id)) throw new Error('图不存在。'); s.activeGraphId = command.id; return s;
    case 'graph.delete': s.graphs = s.graphs!.filter(g => g.id !== command.id); return withWorkspace(s);
    case 'graph.add': {
      const g = s.graphs!.find(g => g.id === command.id); if (!g) throw new Error('图不存在。');
      g.conversationIds = [...new Set([...g.conversationIds, ...command.conversationIds.filter(id => s.conversations.some(c => c.id === id))])]; g.updatedAt = Date.now(); return s;
    }
    case 'node.tags': {
      const c = s.conversations.find(c => c.id === command.node.conversationId); if (!c) throw new Error('对话不存在。');
      const tags = [...new Set(command.tags.map(t => t.trim()).filter(Boolean))].slice(0, 50);
      if (command.primaryTagId && !s.tagEntries!.some(tag => tag.id === command.primaryTagId && tag.kind === 'tag' && tags.includes(tag.name))) throw new Error('主色必须来自已选择的 Tag。');
      if (command.node.turnId) {
        if (!c.turns.some(t => t.id === command.node.turnId)) throw new Error('问题不存在。');
        const old = s.questionMeta!.find(q => nodeKey(q) === nodeKey(command.node));
        s.questionMeta = [...s.questionMeta!.filter(q => nodeKey(q) !== nodeKey(command.node)), { conversationId: c.id, turnId: command.node.turnId, tags, primaryTagId: command.primaryTagId ?? old?.primaryTagId }];
      } else { c.tags = tags; if (command.primaryTagId) c.primaryTagId = command.primaryTagId; }
      return withWorkspace(s);
    }
    case 'tag.save': {
      const old = s.tagEntries!.find(x => x.id === command.tag.id);
      const t: TagEntry = { ...command.tag, color: command.tag.color ?? old?.color, name: command.tag.name.trim().slice(0, 200) }; if (!t.name) throw new Error('请输入名称。');
      if (t.kind === 'tag' && s.tagEntries!.some(x => x.id !== t.id && x.kind === 'tag' && x.name === t.name)) throw new Error('Tag 已存在，请使用合并。');
      if (old && old.kind !== t.kind) throw new Error('不能改变目录类型。');
      s.tagEntries = [...s.tagEntries!.filter(x => x.id !== t.id), t]; checkTree(s.tagEntries);
      if (old?.kind === 'tag' && old.name !== t.name) renameTag(s, old.name, t.name); return withWorkspace(s);
    }
    case 'tag.merge': {
      const from = s.tagEntries!.find(t => t.id === command.fromId), into = s.tagEntries!.find(t => t.id === command.intoId);
      if (!from || !into || from.kind !== 'tag' || into.kind !== 'tag' || from.id === into.id) throw new Error('请选择两个不同的 Tag。');
      renameTag(s, from.name, into.name);
      for (const node of [...s.conversations, ...s.questionMeta!]) if (node.primaryTagId === from.id) node.primaryTagId = into.id;
      s.tagEntries = s.tagEntries!.filter(t => t.id !== from.id); return withWorkspace(s);
    }
    case 'tag.delete': {
      const removing = new Set([command.id]); let changed = true;
      while (changed) { changed = false; for (const t of s.tagEntries!) if (t.parentId && removing.has(t.parentId) && !removing.has(t.id)) { removing.add(t.id); changed = true; } }
      for (const t of s.tagEntries!) if (removing.has(t.id) && t.kind === 'tag') renameTag(s, t.name, null);
      s.tagEntries = s.tagEntries!.filter(t => !removing.has(t.id)); return withWorkspace(s);
    }
    case 'stage.save': {
      const item = structuredClone(command.item);
      const identity = stagedIdentity(item.source, item.node);
      const existing = s.staged!.find(entry => stagedIdentity(entry.source, entry.node) === identity);
      if (existing) {
        s.staged = s.staged!.map(entry => stagedIdentity(entry.source, entry.node) === identity ? { ...existing, selected: item.id === existing.id ? item.selected : true } : entry);
        return s;
      }
      s.staged = [...s.staged!, item];
      return s;
    }
    case 'stage.delete': s.staged = s.staged!.filter(t => t.id !== command.id); return s;
    case 'openMode.save': s.openMode = command.mode; return s;
    default: return null;
  }
}
