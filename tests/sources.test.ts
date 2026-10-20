import { describe, expect, it } from 'vitest';
import { applyCommand, bindDraft, createInitialState, exportBackup, validateBackup } from '../src/core/state';
import { newGraph, withWorkspace } from '../src/core/workspace';
import { selectionSource, sourceConversation } from '../src/core/sources';
import type { Conversation, Draft, PageSnapshot, SourceSnapshot } from '../src/core/types';

const make = (id: string, url = 'https://chat.deepseek.com/a/chat/s/' + id, site = 'deepseek'): Conversation => ({ id, site, externalId: id, url, title: '同名对话', customTitle: false, containerId: null, tags: [], starred: false, archived: false, turns: [{ id: 'q', aliases: ['old-q'], user: '来源问题', assistant: '来源回答', index: 0, fingerprint: 'f' }], complete: true, createdAt: 1, updatedAt: 1 });
const source = (id: string, conversationId: string | null = null): SourceSnapshot => ({ id: 's-' + id, conversationId, url: 'https://chat.deepseek.com/a/chat/' + id + '/?tracking=1#message', title: '冻结标题', text: '冻结内容', turnIds: ['old-q'], capturedAt: 1 });
const draft = (sources: SourceSnapshot[], overrides: Partial<Draft> = {}): Draft => ({ id: 'd', sources, graphId: 'graph', question: '继续', prompt: '发送的提问', action: 'followup', templateId: 'followup', destination: 'new', status: 'filled', createdAt: 1, ...overrides });
const snapshot: PageSnapshot = { site: 'deepseek', externalId: 'child', url: 'https://chat.deepseek.com/a/chat/s/child', title: '后续对话', turns: [{ id: 'first', user: '发送的提问', assistant: '', index: 0, fingerprint: 'new' }], complete: false };

describe('conversation source identity and provenance', () => {
  it.each([
    ['deepseek', 'https://chat.deepseek.com/a/chat/s/a', 'https://chat.deepseek.com/a/chat/a/?from=menu#question'],
    ['chatgpt', 'https://chatgpt.com/c/a', 'https://chatgpt.com/c/a/?from=menu#question'],
    ['gemini', 'https://gemini.google.com/app/a', 'https://gemini.google.com/app/a?from=menu#question']
  ])('resolves %s selection URLs and message aliases', (site, saved, selected) => {
    const state = { ...createInitialState(), conversations: [make('a', saved, site)] }, selection = { title: '片段', text: '引用原文', url: selected, turnId: 'old-q' };
    expect(selectionSource(state, selection)).toMatchObject({ conversationId: 'a', turnIds: ['q'], url: selected, text: selection.text });
    expect(sourceConversation(state, { url: selected })?.id).toBe('a');
  });
  it('does not guess parents from titles or create a node for a normal web source', () => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a')] });
    const selection = { title: '同名对话', text: '普通网页', url: 'https://example.com/a' };
    expect(selectionSource(state, selection).conversationId).toBeNull();
    expect(sourceConversation(state, { url: 'https://chatgpt.com/c/a' })).toBeUndefined();
    const next = applyCommand(state, { type: 'stage.save', item: { id: 'web', source: selectionSource(state, selection), selected: true, createdAt: 1 } });
    expect(next.conversations).toHaveLength(1); expect(next.staged![0]!.source.url).toBe(selection.url);
  });
  it('repairs historical relations, staged sources and drafts without changing frozen evidence or layout', () => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a'), make('child')] });
    state.relations = [{ id: 'r', targetId: 'child', source: source('a'), createdAt: 1 }];
    state.drafts = [draft([source('a')], { editedSources: [{ ...source('a'), text: '编辑后的文本' }] })];
    state.staged = [{ id: 'stage', source: source('a'), selected: true, createdAt: 1 }];
    state.graphs![0]!.layoutVersion = 2; state.graphs![0]!.positions = { a: { x: 12, y: 48 } };
    const next = withWorkspace(state);
    for (const frozen of [next.relations[0]!.source, next.drafts[0]!.sources[0]!, next.staged![0]!.source]) expect(frozen).toMatchObject({ conversationId: 'a', title: '冻结标题', text: '冻结内容', turnIds: ['q'] });
    expect(next.drafts[0]!.editedSources![0]).toMatchObject({ conversationId: 'a', text: '编辑后的文本' });
    expect(next.graphs).toEqual(state.graphs); expect(withWorkspace(next)).toEqual(next);
    expect(state.relations[0]!.source.conversationId).toBeNull();
    expect(validateBackup(exportBackup(next)).relations).toEqual(next.relations);
  });
  it('does not turn unresolved historical evidence into self-links or cycles', () => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a'), make('b')] });
    state.relations = [{ id: 'self', targetId: 'a', source: source('a'), createdAt: 1 }, { id: 'a-b', targetId: 'b', source: source('a', 'a'), createdAt: 1 }, { id: 'b-a', targetId: 'a', source: source('b'), createdAt: 1 }];
    const next = withWorkspace(state);
    expect(next.relations[0]!.source.conversationId).toBeNull(); expect(next.relations[2]!.source.conversationId).toBeNull();
    expect(() => validateBackup(exportBackup(next))).not.toThrow();
  });
  it('binds retained sources to the initiating graph once, preserving multiple snippets', () => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a'), make('b')] });
    state.graphs = [{ ...newGraph('发起图'), id: 'graph' }, { ...newGraph('其他图'), id: 'other', conversationIds: ['a'] }]; state.activeGraphId = 'other';
    const web = { ...source('web'), url: 'https://example.com/page', turnIds: [] };
    state.drafts = [draft([source('a'), { ...source('a'), id: 'another-fragment', text: '第二段引用' }, source('b'), web])];
    const next = bindDraft(state, 'd', snapshot), target = next.conversations.find(c => c.externalId === 'child')!;
    expect(next.graphs![0]!.conversationIds).toEqual(['a', 'b', target.id]); expect(next.graphs![1]!.conversationIds).toEqual(['a']); expect(next.activeGraphId).toBe('other');
    expect(next.relations.map(r => r.source.conversationId)).toEqual(['a', 'a', 'b', null]); expect(next.relations[1]!.source.text).toBe('第二段引用');
    expect(bindDraft(next, 'd', snapshot)).toBe(next); expect(state.relations).toEqual([]);
    expect(validateBackup(exportBackup(next)).relations).toEqual(next.relations);
  });
  it.each(['preview', 'waiting', 'failed'] as const)('does not bind %s drafts or add parents', status => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a')] }); state.drafts = [draft([source('a')], { status })];
    expect(bindDraft(state, 'd', snapshot)).toBe(state); expect(state.relations).toEqual([]);
  });
  it('does not create derivation links for current-conversation followups or mismatched sends', () => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a')] }); state.drafts = [draft([source('a')], { destination: 'current' })];
    expect(bindDraft(state, 'd', snapshot)).toBe(state);
    state.drafts[0]!.destination = 'new'; expect(bindDraft(state, 'd', { ...snapshot, turns: [{ ...snapshot.turns[0]!, user: '另一个问题' }] })).toBe(state);
  });
});
