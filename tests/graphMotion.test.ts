import { describe, expect, it } from 'vitest';
import { conversationPositions, graphPositions, GraphMotion, questionOffset, type MotionNode, type Point } from '../src/ui/graphMotion';
import { GRAPH_LAYOUT_VERSION, newGraph, nodeKey } from '../src/core/workspace';
import { applyCommand, createInitialState, exportBackup, validateBackup } from '../src/core/state';
import type { Conversation } from '../src/core/types';

const size = { width: 420, height: 660 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const conversation = (id: string, x: number, y: number, expanded = false): MotionNode => ({ id, position: { x, y }, data: { kind: 'conversation', ref: { conversationId: id }, expanded } });
const run = (motion: GraphMotion) => { for (let i = 0; i < 180; i++) motion.step(); };
const sample = (id: string): Conversation => ({ id, title: '知识图中的相关对话', site: 'deepseek', externalId: id, url: 'https://chat.deepseek.com/a/chat/s/' + id, customTitle: false, containerId: null, tags: [], starred: false, archived: false, complete: true, createdAt: 1, updatedAt: 1,
  turns: Array.from({ length: 12 }, (_, i) => ({ id: 'q' + i, user: '问题 ' + i, assistant: '回答', index: i, fingerprint: 'f' + i })) });

describe('compact graph layout', () => {
  it.each([{ width: 320, height: 620 }, { width: 940, height: 680 }])('packs related conversations at readable, short distances in %o', viewport => {
    const positions = conversationPositions(['a', 'b', 'c'], viewport, [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]);
    for (const id of ['b', 'c']) expect(distance(positions.a!, positions[id]!)).toBeGreaterThan(85);
    for (const id of ['b', 'c']) expect(distance(positions.a!, positions[id]!)).toBeLessThan(160);
  });
  it('keeps intentional anchors when adding nodes and stays finite for disconnected graphs', () => {
    const anchors = { a: { x: 500, y: -200 }, b: { x: 620, y: -200 } };
    const positions = conversationPositions(['a', 'b', 'c'], size, [{ source: 'b', target: 'c' }], anchors);
    expect(positions.a).toEqual(anchors.a); expect(positions.b).toEqual(anchors.b);
    expect(distance(positions.b!, positions.c!)).toBeLessThan(160);
    const isolated = conversationPositions(Array.from({ length: 30 }, (_, i) => String(i)), size);
    for (const p of Object.values(isolated)) expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Math.hypot(p.x, p.y) < 600).toBe(true);
  });
  it('migrates old coordinates once and roundtrips the marker and later drags in backups', () => {
    const conversations = [sample('a'), sample('b')], graph = { ...newGraph(), conversationIds: ['a', 'b'], positions: { a: { x: 9000, y: 9000 }, b: { x: -9000, y: 0 } } };
    const links = [{ source: 'a', target: 'b' }], positions = graphPositions(graph, conversations, size, links);
    expect(distance(positions.a!, positions.b!)).toBeLessThan(160);
    expect(graph.positions.a).toEqual({ x: 9000, y: 9000 });
    const initial = { ...createInitialState(), conversations, graphs: [graph], activeGraphId: graph.id };
    const migrated = applyCommand(initial, { type: 'graph.patch', id: graph.id, patch: { positions, layoutVersion: GRAPH_LAYOUT_VERSION } });
    const dragged = applyCommand(migrated, { type: 'graph.patch', id: graph.id, patch: { positions: { a: { x: 750, y: 600 } } } });
    const restored = validateBackup(JSON.parse(JSON.stringify(exportBackup(dragged))));
    expect(restored.graphs![0]!.layoutVersion).toBe(GRAPH_LAYOUT_VERSION);
    const reopened = graphPositions(restored.graphs![0]!, restored.conversations, { width: 1200, height: 700 }, links);
    expect(reopened.a).toEqual({ x: 750, y: 600 });
    expect(reopened[nodeKey({ conversationId: 'a', turnId: 'q0' })]).toEqual(positions[nodeKey({ conversationId: 'a', turnId: 'q0' })]);
    const legacy = validateBackup(exportBackup(initial));
    expect(legacy.graphs![0]!.layoutVersion).toBeUndefined();
    expect(() => validateBackup({ ...restored, graphs: [{ ...restored.graphs![0], layoutVersion: 'bad' }] })).toThrow();
  });
});

describe('graph motion', () => {
  it('makes room for actual questions and returns to the same anchors after repeated expansion', () => {
    const offset = questionOffset(0, 2), a = conversation('a', 0, 0), b = conversation('b', offset.x, 0);
    const q: MotionNode = { id: 'q', hidden: true, position: offset, data: { kind: 'question', ref: { conversationId: 'a' } } };
    const motion = new GraphMotion(); motion.sync([a, b, q]); run(motion); motion.settle();
    const before = motion.positions();
    for (let cycle = 0; cycle < 3; cycle++) {
      motion.sync([{ ...a, data: { ...a.data, expanded: true } }, b, { ...q, hidden: false }]); run(motion); motion.settle();
      expect(distance(motion.positions().b!, before.b!)).toBeGreaterThan(3);
      expect(distance(motion.savedPositions().b!, b.position)).toBeLessThan(0.01);
      motion.sync([a, b, q]); run(motion); motion.settle();
      expect(distance(motion.positions().a!, before.a!)).toBeLessThan(1);
      expect(distance(motion.positions().b!, before.b!)).toBeLessThan(1);
    }
  });
  it('repels overlapping dots and softly follows a dragged parent without saving temporary displacement', () => {
    const motion = new GraphMotion(), offset = questionOffset(0, 2);
    const a = conversation('a', 0, 0, true), b = conversation('b', 0, 0);
    const q: MotionNode = { id: 'q', position: offset, data: { kind: 'question', ref: { conversationId: 'a' } } };
    motion.sync([a, b, q]); run(motion); motion.settle();
    const before = motion.positions();
    expect(distance(before.a!, before.b!)).toBeGreaterThan(28);
    motion.drag('a', { x: before.a!.x + 500, y: before.a!.y }); motion.step();
    expect(motion.positions().q!.x - before.q!.x).toBeGreaterThan(0);
    expect(motion.positions().q!.x - before.q!.x).toBeLessThan(20);
    run(motion); motion.release(); run(motion); motion.settle();
    expect(motion.positions().q!.x).toBeGreaterThan(before.q!.x + 400);
    expect(motion.savedPositions().a!.x).toBeCloseTo(before.a!.x + 500, 1);
    expect(motion.savedPositions().b).toEqual(b.position);
    for (const p of Object.values(motion.positions())) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
