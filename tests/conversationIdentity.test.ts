import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationIdentity } from '../src/adapters/platforms';
import { applyCommand, captureSnapshot, createInitialState, exportBackup, updateCaptured, validateBackup } from '../src/core/state';
import { nodeKey, withWorkspace } from '../src/core/workspace';
import { openPage } from '../src/core/navigation';
import type { Conversation, SourceSnapshot } from '../src/core/types';

const url = 'https://chat.deepseek.com/a/chat/s/same';
const make = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({ id, site: 'deepseek', externalId: 'same', url, title: '测试在线交互', customTitle: false, containerId: null, tags: [], starred: false, archived: false, complete: false, createdAt: 1, updatedAt: 1, turns: [{ id: 'same:message:1', user: '问题', assistant: '回答', index: 0, fingerprint: 'hash' }], ...overrides });
const source = (id: string): SourceSnapshot => ({ id: 'frozen-' + id, conversationId: id, title: '保留的来源标题', url, text: '冻结的引用原文', turnIds: ['same:message:1'], capturedAt: 1 });

describe('conversation identity when reopening', () => {
  it('recognizes URL variants and legacy external IDs without using titles', () => {
    expect(conversationIdentity(make('a'))).toBe(conversationIdentity(make('b', { site: 'chat.deepseek.com', externalId: url, url: 'https://chat.deepseek.com/a/chat/same/?tracking=x#message' })));
    expect(conversationIdentity(make('a'))).not.toBe(conversationIdentity(make('b', { url: 'https://chat.deepseek.com/a/chat/s/another', externalId: 'another' })));
    expect(conversationIdentity(make('a'))).not.toBe(conversationIdentity(make('b', { url: 'https://chatgpt.com/c/same', site: 'chatgpt' })));
  });
  it('updates a legacy record repeatedly without adding another conversation or graph node', () => {
    const legacy = make('original', { site: 'chat.deepseek.com', externalId: url }), initial = withWorkspace({ ...createInitialState(), conversations: [legacy] });
    let state = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      state = updateCaptured(state, { site: 'deepseek', externalId: 'same', url, title: '网页标题', turns: legacy.turns, complete: false });
      state = captureSnapshot(state, { site: 'deepseek', externalId: 'same', url: url + '?reopen=true', title: '网页标题', turns: legacy.turns, complete: false }).state;
    }
    expect(state.conversations).toHaveLength(1); expect(state.conversations[0]).toMatchObject({ id: 'original', site: 'deepseek', externalId: 'same' });
    expect(state.graphs![0]!.conversationIds).toEqual(['original']);
    expect(initial.conversations[0]!.externalId).toBe('same');
    expect(legacy.externalId).toBe(url);
  });
  it('repairs duplicate nodes and remaps metadata and positions without losing frozen sources', () => {
    const old = make('original', { customTitle: true, title: '手动命名', tags: ['原 Tag'] }), duplicate = make('duplicate', { externalId: url, tags: ['新 Tag'], starred: true, createdAt: 2, updatedAt: 3, turns: [...old.turns, { id: 'same:message:2', user: '继续', assistant: '更多回答', index: 1, fingerprint: 'next' }] });
    const target = make('target', { externalId: 'different', url: 'https://chat.deepseek.com/a/chat/s/different' });
    const state = withWorkspace({ ...createInitialState(), conversations: [old, target] }), graph = state.graphs![0]!;
    state.conversations.push(duplicate);
    graph.conversationIds = ['original', 'duplicate', 'original', 'target']; graph.expanded = ['duplicate']; graph.layoutVersion = 2;
    graph.positions = { original: { x: 10, y: 20 }, duplicate: { x: 900, y: 500 }, [nodeKey({ conversationId: 'duplicate', turnId: 'same:message:2' })]: { x: 30, y: 40 } };
    state.relations = [{ id: 'relation', targetId: 'target', source: source('duplicate'), createdAt: 1 }];
    state.drafts = [{ id: 'draft', sources: [source('duplicate')], editedSources: [source('duplicate')], question: '', action: 'followup', templateId: 'followup', prompt: '', destination: 'new', status: 'preview', createdAt: 1 }];
    state.questionMeta = [{ conversationId: 'original', turnId: old.turns[0]!.id, tags: ['A'] }, { conversationId: 'duplicate', turnId: old.turns[0]!.id, tags: ['B'] }];
    state.staged = [{ id: 'stage', source: source('duplicate'), node: { conversationId: 'duplicate' }, selected: true, createdAt: 1 }];
    state.snippets = [{ id: 'snippet', conversationId: 'duplicate', turnId: old.turns[0]!.id, text: '片段原文', title: '', url, createdAt: 1 }];
    const repaired = withWorkspace(state);
    expect(repaired.conversations).toHaveLength(2);
    expect(repaired.conversations[0]).toMatchObject({ id: 'original', title: '手动命名', starred: true, tags: ['原 Tag', '新 Tag'] });
    expect(repaired.conversations[0]!.turns).toHaveLength(2);
    expect(repaired.graphs![0]!.conversationIds).toEqual(['original', 'target']);
    expect(repaired.graphs![0]!.expanded).toEqual(['original']);
    expect(repaired.graphs![0]!.positions.original).toEqual({ x: 10, y: 20 });
    expect(repaired.graphs![0]!.positions[nodeKey({ conversationId: 'original', turnId: 'same:message:2' })]).toEqual({ x: 30, y: 40 });
    expect(repaired.relations[0]!.source).toMatchObject({ conversationId: 'original', text: '冻结的引用原文', title: '保留的来源标题' });
    expect(repaired.drafts[0]!.sources[0]!.conversationId).toBe('original'); expect(repaired.drafts[0]!.editedSources![0]!.conversationId).toBe('original');
    expect(repaired.staged![0]!.node!.conversationId).toBe('original'); expect(repaired.snippets[0]!.conversationId).toBe('original');
    expect(repaired.questionMeta![0]!.tags).toEqual(['A', 'B']);
    expect(withWorkspace(repaired)).toEqual(repaired);
    expect(validateBackup(exportBackup(repaired)).graphs![0]!.conversationIds).toEqual(['original', 'target']);
    expect(state.graphs![0]!.conversationIds).toHaveLength(4);
  });
  it('keeps separate conversations with the same title and removes repeated graph IDs', () => {
    const state = withWorkspace({ ...createInitialState(), conversations: [make('a'), make('b', { externalId: 'another', url: 'https://chat.deepseek.com/a/chat/s/another' })] });
    state.graphs![0]!.conversationIds = ['a', 'a', 'b'];
    const next = withWorkspace(state);
    expect(next.conversations).toHaveLength(2); expect(next.graphs![0]!.conversationIds).toEqual(['a', 'b']);
    expect(applyCommand(next, { type: 'graph.activate', id: next.graphs![0]!.id }).conversations).toHaveLength(2);
  });
});

describe('reusing the existing split conversation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('activates the existing pane for a canonical URL match without creating or reloading tabs', async () => {
    const tabs = [{ id: 1, windowId: 1, index: 0, splitViewId: 7, url: 'https://chat.deepseek.com/a/chat/s/left' }, { id: 2, windowId: 1, index: 1, splitViewId: 7, url: url + '?source=sidebar' }];
    const create = vi.fn(), update = vi.fn(async (id, patch) => ({ ...tabs.find(tab => tab.id === id), ...patch }));
    vi.stubGlobal('chrome', { tabs: { get: vi.fn(async id => tabs.find(tab => tab.id === id)), query: vi.fn(async () => tabs), create, update } });
    for (let i = 0; i < 3; i++) expect((await openPage(url, 'split', 1)).tab.id).toBe(2);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(3); expect(update).toHaveBeenLastCalledWith(2, { active: true });
  });
});
