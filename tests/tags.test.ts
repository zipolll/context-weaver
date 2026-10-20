import { describe, expect, it } from 'vitest';
import { applyCommand, createInitialState, exportBackup, validateBackup } from '../src/core/state';
import { withWorkspace } from '../src/core/workspace';
import { primaryTag } from '../src/core/tags';
import type { AppState, Conversation, NodeRef } from '../src/core/types';

const conversation = (): Conversation => ({ id: 'a', site: 'deepseek', externalId: 'a', url: 'https://chat.deepseek.com/a/chat/s/a', title: '对话', customTitle: false, containerId: null, tags: ['研究', '灵感'], starred: false, archived: false, turns: [{ id: 'q', user: '问题', assistant: '回答', index: 0, fingerprint: 'f' }], complete: true, createdAt: 1, updatedAt: 1 });
const initial = () => withWorkspace({ ...createInitialState(), conversations: [conversation()] });
const ref = { conversationId: 'a' }, question = { ...ref, turnId: 'q' };
const entry = (state: AppState, name: string) => state.tagEntries!.find(tag => tag.name === name)!;
const choose = (state: AppState, node: NodeRef, tags: string[], primary?: string) => applyCommand(state, { type: 'node.tags', node, tags, ...(primary ? { primaryTagId: entry(state, primary).id } : {}) });

describe('node Tag colors and primary Tag', () => {
  it('upgrades old tags deterministically without moving nodes or mutating input', () => {
    const raw = { ...createInitialState(), conversations: [conversation()] }, one = withWorkspace(raw), two = withWorkspace(raw);
    expect(one.tagEntries).toEqual(two.tagEntries);
    expect(one.conversations[0]!.primaryTagId).toBe(entry(one, '研究').id);
    expect(new Set(one.tagEntries!.map(tag => tag.color)).size).toBe(2);
    expect(raw.conversations[0]!.primaryTagId).toBeUndefined(); expect(raw.tagEntries).toBeUndefined();
    one.graphs![0]!.layoutVersion = 2; one.graphs![0]!.positions = { a: { x: 71, y: 93 } };
    const again = withWorkspace(one); expect(again).toEqual(one);
    expect(again.graphs![0]!.positions.a).toEqual({ x: 71, y: 93 }); expect(again.graphs![0]!.layoutVersion).toBe(2);
  });
  it('allocates distinct colors beyond the palette while preserving already assigned colors', () => {
    const raw = initial(); raw.tagEntries = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i, name: '标签' + i, kind: 'tag' as const, parentId: null, ...(i < 2 ? { color: '#8070C7' } : {}) }));
    const state = withWorkspace(raw), colors = state.tagEntries!.map(tag => tag.color);
    expect(colors[0]).toBe('#8070c7'); expect(new Set(colors).size).toBe(colors.length);
    expect(colors.every(color => /^#[a-f0-9]{6}$/.test(color!))).toBe(true);
    expect(withWorkspace(state).tagEntries).toEqual(state.tagEntries);
  });
  it('selects independent colors for conversation and question, and clears them independently', () => {
    let state = choose(initial(), ref, ['研究', '灵感'], '灵感');
    state = choose(state, question, ['研究']);
    expect(primaryTag(state, ref)?.name).toBe('灵感'); expect(primaryTag(state, question)?.name).toBe('研究');
    expect(state.conversations[0]!.tags).toEqual(['研究', '灵感']);
    state = choose(state, ref, []); expect(primaryTag(state, ref)).toBeUndefined();
    expect(primaryTag(state, question)?.name).toBe('研究');
    state = choose(state, question, []); expect(state.questionMeta![0]!.primaryTagId).toBeUndefined();
  });
  it('preserves the primary on old commands and falls back in stored Tag order after removal', () => {
    let state = choose(initial(), ref, ['研究', '灵感'], '灵感');
    state = choose(state, ref, ['研究', '灵感', '待验证']); expect(primaryTag(state, ref)?.name).toBe('灵感');
    state = applyCommand(state, { type: 'conversation.patch', id: 'a', patch: { tags: ['待验证', '研究'] } });
    expect(primaryTag(state, ref)?.name).toBe('待验证');
    expect(() => choose(state, question, ['研究'], '待验证')).toThrow('主色');
  });
  it('renames a Tag without changing its color or primary references', () => {
    let state = choose(initial(), question, ['研究', '灵感'], '灵感'), tag = entry(state, '灵感');
    state = applyCommand(state, { type: 'tag.save', tag: { id: tag.id, name: '新灵感', kind: 'tag', parentId: null } });
    expect(entry(state, '新灵感')).toMatchObject({ id: tag.id, color: tag.color });
    expect(primaryTag(state, question)?.id).toBe(tag.id); expect(state.questionMeta![0]!.tags).toEqual(['研究', '新灵感']);
  });
  it('merges both kinds of primary references into the target color', () => {
    let state = choose(initial(), ref, ['研究', '灵感'], '灵感'); state = choose(state, question, ['灵感']);
    const target = entry(state, '研究'), from = entry(state, '灵感');
    state = applyCommand(state, { type: 'tag.merge', fromId: from.id, intoId: target.id });
    expect(primaryTag(state, ref)).toEqual(target); expect(primaryTag(state, question)).toEqual(target);
    expect(state.conversations[0]!.tags).toEqual(['研究']); expect(state.questionMeta![0]!.tags).toEqual(['研究']);
    expect(state.tagEntries).not.toContainEqual(expect.objectContaining({ id: from.id }));
  });
  it('deletes a Tag folder and falls back to remaining tags or default color', () => {
    let state = choose(initial(), ref, ['灵感', '研究'], '灵感'); state = choose(state, question, ['灵感']);
    state = applyCommand(state, { type: 'tag.save', tag: { id: 'folder', name: '文件夹', kind: 'folder', parentId: null } });
    state = applyCommand(state, { type: 'tag.save', tag: { ...entry(state, '灵感'), parentId: 'folder' } });
    const remainingColor = entry(state, '研究').color;
    state = applyCommand(state, { type: 'tag.delete', id: 'folder' });
    expect(primaryTag(state, ref)?.color).toBe(remainingColor); expect(primaryTag(state, question)).toBeUndefined();
    expect(state.tagEntries).toHaveLength(1); expect(state.questionMeta![0]!.tags).toEqual([]);
  });
  it('roundtrips colors and both primary references through export and import', () => {
    let state = choose(initial(), ref, ['研究', '灵感'], '灵感'); state = choose(state, question, ['研究']);
    const restored = applyCommand(createInitialState(), { type: 'backup.import', data: JSON.parse(JSON.stringify(exportBackup(state))) });
    expect(restored.tagEntries).toEqual(state.tagEntries); expect(restored.conversations).toEqual(state.conversations); expect(restored.questionMeta).toEqual(state.questionMeta);
    expect(restored.version).toBe(1); expect(primaryTag(restored, ref)?.name).toBe('灵感');
  });
  it('restores the saved default graph after clearing data despite a newer empty graph', () => {
    const state = initial(), graph = state.graphs![0]!; graph.updatedAt = 1; graph.layoutVersion = 2; graph.positions = { a: { x: 89, y: 76 } };
    const cleared = withWorkspace(applyCommand(state, { type: 'data.clear' })); expect(cleared.graphs![0]!.updatedAt).toBeGreaterThan(graph.updatedAt);
    const restored = applyCommand(cleared, { type: 'backup.import', data: exportBackup(state) });
    expect(restored.graphs!.find(g => g.id === graph.id)).toEqual(graph); expect(primaryTag(restored, ref)?.color).toBe(primaryTag(state, ref)?.color);
  });
  it('merges same-named Tag identities from independent backups and redirects their primaries', () => {
    let state = initial(); const research = entry(state, '研究');
    const other = initial(); other.tagEntries = [{ ...research, id: 'imported-research', color: '#123456' }]; other.conversations[0]!.primaryTagId = 'imported-research'; other.conversations[0]!.updatedAt = Date.now();
    other.questionMeta = [{ conversationId: 'a', turnId: 'q', tags: ['研究'], primaryTagId: 'imported-research' }];
    state = applyCommand(state, { type: 'backup.import', data: other });
    expect(state.tagEntries!.filter(tag => tag.name === '研究')).toEqual([research]);
    expect(primaryTag(state, ref)).toEqual(research); expect(primaryTag(state, question)).toEqual(research);
    expect(validateBackup(exportBackup(state))).toEqual(state);
  });
  it.each(['red', '#fff', 'url(https://example.com/x)', '#12345678'])('rejects invalid backup color %s', color => {
    const state = initial(); state.tagEntries![0]!.color = color; expect(() => validateBackup(state)).toThrow('颜色');
  });
  it('retains a primary from duplicate records while preserving all old tags', () => {
    let state = initial(); state.conversations[0]!.primaryTagId = undefined;
    const duplicate = { ...conversation(), id: 'duplicate', tags: ['灵感'], primaryTagId: entry(state, '灵感').id, createdAt: 2 };
    state.conversations.push(duplicate); state = withWorkspace(state);
    expect(state.conversations).toHaveLength(1); expect(primaryTag(state, ref)?.name).toBe('灵感');
    expect(state.conversations[0]!.tags).toEqual(['研究', '灵感']);
  });
});
