import { describe, expect, it } from 'vitest';
import { conversationPositions, GraphMotion, questionOffset, type MotionNode } from '../src/ui/graphMotion';

const conversation = (id: string, x: number, y: number, expanded = false): MotionNode => ({ id, position: { x, y }, data: { kind: 'conversation', ref: { conversationId: id }, expanded, questionCount: 2 } });
const run = (motion: GraphMotion) => { for (let i = 0; i < 240; i++) motion.step(); };

describe('graph motion', () => {
  it('keeps stable spaced seeds and pushes neighbours when questions expand', () => {
    expect(conversationPositions(['a', 'b', 'c'], true).a).toEqual(conversationPositions(['a', 'b', 'c', 'd'], true).a);
    const motion = new GraphMotion(), a = conversation('a', 80, 100), b = conversation('b', 108, 320);
    motion.sync([a, b]); run(motion); motion.settle();
    const before = motion.positions();
    motion.sync([{ ...a, data: { ...a.data, expanded: true } }, b]); run(motion);
    expect(motion.positions().a).toEqual(before.a);
    expect(motion.positions().b!.y).toBeGreaterThan(before.b!.y + 10);
  });
  it('repels overlapping nodes and softly attracts children during a long drag', () => {
    const motion = new GraphMotion(), offset = questionOffset(0, 2);
    const a = conversation('a', 0, 0, true), b = conversation('b', 0, 0);
    const q: MotionNode = { id: 'q', position: offset, data: { kind: 'question', ref: { conversationId: 'a' } } };
    motion.sync([a, b, q]); run(motion); motion.settle();
    const before = motion.positions();
    expect(Math.hypot(before.a!.x - before.b!.x, before.a!.y - before.b!.y)).toBeGreaterThan(80);
    motion.drag('a', { x: before.a!.x + 500, y: before.a!.y });
    motion.step();
    const first = motion.positions().q!;
    expect(first.x - before.q!.x).toBeGreaterThan(0);
    expect(first.x - before.q!.x).toBeLessThan(20);
    run(motion); motion.release(); run(motion);
    expect(motion.positions().q!.x).toBeGreaterThan(before.q!.x + 400);
    for (const p of Object.values(motion.positions())) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
