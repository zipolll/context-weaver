import { beforeEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { applyCommand, bindDraft, captureSnapshot, createInitialState, exportBackup, updateCaptured, validateBackup } from '../src/core/state';
import { ACTION_LABELS, renderPrompt, snapshotConversation, snapshotSnippet } from '../src/core/context';
import { withWorkspace } from '../src/core/workspace';
import { mutateState, readState } from '../src/core/repository';
import type { AppState, Container, Draft, PageSnapshot, Snippet, SourceSnapshot, Turn } from '../src/core/types';

const turn = (index: number, answer = 'Answer ' + index): Turn => ({ id: 'turn-' + index, user: 'Question ' + index, assistant: answer, index, fingerprint: 'fingerprint-' + index });
const page = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({ site: 'deepseek', externalId: 'conversation-1', url: 'https://chat.deepseek.com/a/chat/s/conversation-1', title: 'Research discussion', turns: [turn(0), turn(1), turn(2)], complete: true, ...overrides });
const container = (id: string, parentId: string | null = null): Container => ({ id, kind: parentId ? 'folder' : 'project', name: id, parentId, order: 0, createdAt: 1 });
const source = (conversationId: string | null = null): SourceSnapshot => ({ id: 'source-1', conversationId, title: 'Source', url: 'https://example.com/source', turnIds: [], text: 'Frozen source text', capturedAt: 1 });
const draft = (overrides: Partial<Draft> = {}): Draft => ({ id: 'draft-1', sources: [source()], question: 'why?', action: 'followup', templateId: 'followup', prompt: 'assembled prompt\nsecond line', destination: 'new', status: 'filled', createdAt: 1, ...overrides });
const captured = () => captureSnapshot(createInitialState(), page());

describe('container and conversation state', () => {
  it('rejects a folder being moved inside its descendant without changing input', () => {
    let state = createInitialState();
    for (const c of [container('project'), container('parent', 'project'), container('child', 'parent')]) state = applyCommand(state, { type: 'container.save', container: c });
    expect(() => applyCommand(state, { type: 'container.save', container: container('parent', 'child') })).toThrow('后代');
    expect(state.containers.find(c => c.id === 'parent')!.parentId).toBe('project');
  });
  it('rejects a folder with an unknown parent', () => {
    expect(() => applyCommand(createInitialState(), { type: 'container.save', container: container('orphan', 'missing') })).toThrow('不存在');
  });
  it('deletes descendants and moves their conversations to unfiled', () => {
    let state = createInitialState();
    for (const c of [container('project'), container('folder', 'project'), container('nested', 'folder')]) state = applyCommand(state, { type: 'container.save', container: c });
    state = captureSnapshot(state, page(), 'nested').state;
    const next = applyCommand(state, { type: 'container.delete', id: 'folder' });
    expect(next.containers.map(c => c.id)).toEqual(['project']);
    expect(next.conversations[0]!.containerId).toBeNull(); expect(next.conversations[0]!.turns).toHaveLength(3);
    expect(state.containers).toHaveLength(3);
  });
  it('merges partial DOM captures without deleting history or overwriting user metadata', () => {
    const initial = captured();
    const customized = applyCommand(initial.state, { type: 'conversation.patch', id: initial.conversation.id, patch: { title: 'My title', tags: ['science', 'science', '  optics  '], starred: true } });
    const next = updateCaptured(customized, page({ title: 'Site generated title', turns: [turn(2, 'Updated answer'), turn(3)], complete: false }));
    expect(next.conversations[0]!.turns.map(t => t.id)).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3']);
    expect(next.conversations[0]!.turns[2]!.assistant).toBe('Updated answer');
    expect(next.conversations[0]).toMatchObject({ title: 'My title', tags: ['science', 'optics'], starred: true, complete: false });
    expect(customized.conversations[0]!.turns[2]!.assistant).toBe('Answer 2');
    expect(next.conversations[0]!.sourceTitle).toBe('Site generated title');
    const noSidebar = updateCaptured(next, page({ title: 'Question 0', sourceTitle: '' }));
    expect(noSidebar.conversations[0]!.sourceTitle).toBe('Site generated title');
  });
  it('does not automatically collect an untracked page', () => {
    const state = createInitialState(); expect(updateCaptured(state, page())).toBe(state);
    expect(() => captureSnapshot(state, page({ externalId: '' }))).toThrow('发送一条消息');
  });
});

describe('context sources and draft binding', () => {
  it('cuts a source through the selected turn and never includes later answers', () => {
    const { conversation } = captured(); const frozen = snapshotConversation(conversation, 'turn-1');
    expect(frozen.turnIds).toEqual(['turn-0', 'turn-1']); expect(frozen.text).toContain('Answer 1'); expect(frozen.text).not.toContain('Answer 2');
    conversation.turns[0]!.assistant = 'changed later'; expect(frozen.text).toContain('Answer 0');
    expect(() => snapshotConversation(conversation, 'missing')).toThrow('轮次');
  });
  it('preserves snippet source location and creation time', () => {
    const snippet: Snippet = { id: 'snippet-1', title: 'Source title', text: 'Selected passage', url: 'https://example.com/page', conversationId: 'conv-1', turnId: 'turn-1', createdAt: 123 };
    expect(snapshotSnippet(snippet)).toMatchObject({ title: snippet.title, text: snippet.text, turnIds: ['turn-1'], conversationId: 'conv-1', capturedAt: 123 });
  });
  it('renders source order and placeholders without recursively expanding quoted text', () => {
    const template = { id: 'test', name: 'test', action: 'explain' as const, body: '{{action}}\n{{question}}\n{{context}}\n{{sources}}' };
    const result = renderPrompt(template, '  explain  ', [{ ...source(), title: 'First', text: '{{question}} remains literal' }, { ...source(), id: 'source-2', title: 'Second', text: 'second passage' }], 'explain');
    expect(result).toContain(ACTION_LABELS.explain + '\nexplain'); expect(result).toContain('{{question}} remains literal');
    expect(result.indexOf('First')).toBeLessThan(result.indexOf('Second')); expect(result).toContain('[2] Second https://example.com/source');
  });
  it('binds only the actual first message and keeps immutable source text', () => {
    const initial = captured(); const d = draft({ sources: [snapshotConversation(initial.conversation)] });
    const state = applyCommand(initial.state, { type: 'draft.save', draft: d });
    expect(bindDraft(state, d.id, page({ externalId: 'target', turns: [{ ...turn(0), user: 'different prompt' }] }))).toBe(state);
    const next = bindDraft(state, d.id, page({ externalId: 'target', turns: [{ ...turn(0), user: '  assembled prompt\r\nsecond line  ' }] }));
    expect(next.conversations).toHaveLength(2); expect(next.drafts[0]!.status).toBe('bound'); expect(next.relations).toHaveLength(1);
    d.sources[0]!.text = 'changed after binding'; expect(next.relations[0]!.source.text).toContain('Answer 0');
    expect(bindDraft(next, d.id, page({ externalId: 'target', turns: [{ ...turn(0), user: d.prompt }] }))).toBe(next);
  });
});

describe('backup validation and merging', () => {
  it('roundtrips state without API credentials or stale tab IDs', () => {
    const initial = captured(); initial.state.drafts.push(draft({ tabId: 123 }));
    const exported = exportBackup(initial.state); const restored = validateBackup(JSON.parse(JSON.stringify(exported)));
    expect(restored.conversations).toEqual(initial.state.conversations); expect(restored.templates).toHaveLength(4);
    expect(restored.drafts[0]!.tabId).toBeUndefined(); expect(restored.drafts[0]!.status).toBe('preview');
    expect(JSON.stringify(exported)).not.toContain('apiKey'); expect(initial.state.drafts[0]!.tabId).toBe(123);
  });
  it('rejects duplicate IDs, invalid target references and bad nested fields', () => {
    const initial = captured();
    expect(() => validateBackup({ ...initial.state, conversations: [initial.conversation, initial.conversation] })).toThrow('重复');
    expect(() => validateBackup({ ...initial.state, relations: [{ id: 'relation', targetId: 'missing', source: source(), createdAt: 1 }] })).toThrow('目标');
    expect(() => validateBackup({ ...initial.state, conversations: [{ ...initial.conversation, containerId: 'missing' }] })).toThrow('目录');
    expect(() => validateBackup({ ...initial.state, conversations: [{ ...initial.conversation, turns: [{ ...turn(0), user: 123 }] }] })).toThrow('文本');
    expect(() => validateBackup({ ...initial.state, drafts: [draft({ templateId: 'missing' })] })).toThrow('模板');
  });
  it.each(['javascript:alert(1)', 'data:text/html,bad', 'https://name:password@example.com'])('rejects executable or credential-bearing URL %s', url => {
    const initial = captured(); expect(() => validateBackup({ ...initial.state, conversations: [{ ...initial.conversation, url }] })).toThrow();
  });
  it('rejects dangerous object prototypes and prototype-related keys at nested levels', () => {
    const initial = createInitialState(); expect(() => validateBackup(Object.assign(Object.create({ polluted: true }), initial))).toThrow();
    const nested = JSON.parse(JSON.stringify(initial)); nested.templates[0].__proto__ = { inherited: true };
    expect(() => validateBackup(nested)).toThrow();
    const raw = JSON.parse(JSON.stringify(initial)); Object.defineProperty(raw.templates[0], '__proto__', { value: {}, enumerable: true });
    expect(() => validateBackup(raw)).toThrow();
  });
  it('preserves frozen sources when their origin conversation has been removed', () => {
    const { state, conversation } = captured();
    state.relations.push({ id: 'relation', targetId: conversation.id, source: source('deleted-origin'), createdAt: 1 });
    expect(validateBackup(state).relations[0]!.source.text).toBe('Frozen source text');
  });
  it('rejects cycles introduced only by merging two valid directory trees', () => {
    const existing = createInitialState(); existing.containers = [container('project'), { ...container('a', 'project'), createdAt: 2 }, { ...container('b', 'a'), createdAt: 4 }];
    const incoming = createInitialState(); incoming.containers = [container('project'), { ...container('b', 'project'), createdAt: 3 }, { ...container('a', 'b'), createdAt: 3 }];
    expect(() => validateBackup(existing)).not.toThrow(); expect(() => validateBackup(incoming)).not.toThrow();
    expect(() => applyCommand(existing, { type: 'backup.import', data: incoming })).toThrow('后代');
  });
  it('keeps the newest conversation when stable IDs collide', () => {
    const initial = captured(); initial.conversation.updatedAt = 200;
    const incoming: AppState = structuredClone(initial.state); incoming.conversations[0]!.updatedAt = 100; incoming.conversations[0]!.title = 'Older copy';
    expect(applyCommand(initial.state, { type: 'backup.import', data: incoming }).conversations[0]!.title).toBe('Research discussion');
  });
});

describe('IndexedDB serialized mutations', () => {
  beforeEach(async () => { await deleteDB('context-weaver'); });
  it('retains every simultaneous mutation and persists the result', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => mutateState(state => applyCommand(state, { type: 'container.save', container: container('project-' + index) }))));
    const persisted = await readState(); expect(persisted.containers).toHaveLength(12);
    expect(new Set(persisted.containers.map(c => c.id)).size).toBe(12);
  });
  it('recovers its queue after a rejected mutation without storing partial data', async () => {
    await expect(mutateState(state => { state.containers.push(container('should-not-persist')); throw new Error('reject mutation'); })).rejects.toThrow('reject mutation');
    await mutateState(state => applyCommand(state, { type: 'container.save', container: container('valid') }));
    expect((await readState()).containers.map(c => c.id)).toEqual(['valid']);
  });
});

describe('staging duplicate regression', () => {
  beforeEach(async () => { await deleteDB('context-weaver'); });
  it('serializes repeated additions and allows unchecking the remaining entry', async () => {
    await Promise.all(['first', 'second', 'third'].map(id => mutateState(s => applyCommand(s, { type: 'stage.save', item: { id, source: source(), selected: true, createdAt: 1 } }))));
    const stored = await readState();
    expect(stored.staged).toHaveLength(1);
    const item = stored.staged![0]!;
    const unchecked = applyCommand(stored, { type: 'stage.save', item: { ...item, selected: false } });
    expect(unchecked.staged![0]!.selected).toBe(false);
    const selected = applyCommand(unchecked, { type: 'stage.save', item: { ...item, id: 'new-action', selected: true } });
    expect(selected.staged).toHaveLength(1);
    expect(selected.staged![0]!.selected).toBe(true);
  });
  it('cleans old duplicates without merging different origins, turns or code spacing', () => {
    const state = createInitialState();
    const item = { id: 'old', source: source(), selected: false, createdAt: 1 };
    state.staged = [item, { ...item, id: 'duplicate', source: { ...source(), text: ' Frozen source text\r\n' } },
      { ...item, id: 'other-url', source: { ...source(), url: 'https://example.com/other' } },
      { ...item, id: 'other-turn', source: { ...source(), turnIds: ['turn-1'] } },
      { ...item, id: 'other-spacing', source: { ...source(), text: 'Frozen  source text' } }];
    const migrated = withWorkspace(state);
    expect(migrated.staged!.map(entry => entry.id)).toEqual(['old', 'other-url', 'other-turn', 'other-spacing']);
    expect(migrated.staged![0]!.selected).toBe(false);
    expect(state.staged).toHaveLength(5);
  });
});
