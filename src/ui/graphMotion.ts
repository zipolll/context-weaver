import type { Conversation, KnowledgeGraph } from '../core/types';
import { GRAPH_LAYOUT_VERSION, nodeKey } from '../core/workspace';

export type Point = { x: number; y: number };
export type CanvasSize = { width: number; height: number };
export type MotionLink = { source: string; target: string };
export type MotionNode = { id: string; position: Point; hidden?: boolean; data: { kind: 'conversation' | 'question'; ref: { conversationId: string }; expanded?: boolean; labelWidth?: number } };
type Body = { id: string; kind: 'conversation' | 'question'; parent: string; position: Point; home: Point; offset: Point; velocity: Point; visible: boolean; expanded: boolean; labelWidth: number };
const rounded = (p: Point): Point => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

export function labelWidth(title: string): number {
  return Math.min(104, Math.max(24, Array.from(title).reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 13 : 7), 0)));
}

/** Deterministic, relation-aware seeds. Existing anchors stay fixed when adding nodes. */
export function conversationPositions(ids: string[], size: CanvasSize, links: MotionLink[] = [], anchors: Record<string, Point> = {}, widths: Record<string, number> = {}): Record<string, Point> {
  if (ids.every(id => anchors[id])) return Object.fromEntries(ids.map(id => [id, { ...anchors[id]! }]));
  const aspect = Math.max(0.45, Math.min(1.65, size.width / Math.max(1, size.height))), stretch = Math.sqrt(aspect);
  const nodes = ids.map((id, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5)), radius = i ? 78 * Math.sqrt(i) : 0;
    return { id, x: anchors[id]?.x ?? Math.cos(angle) * radius * stretch, y: anchors[id]?.y ?? Math.sin(angle) * radius / stretch, vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map(node => [node.id, node])), unique = new Set<string>();
  const springs = links.filter(link => {
    const key = JSON.stringify([link.source, link.target].sort());
    if (link.source === link.target || !byId.has(link.source) || !byId.has(link.target) || unique.has(key)) return false;
    unique.add(key); return true;
  });
  const fixed = nodes.filter(node => anchors[node.id]);
  const center = fixed.length ? { x: fixed.reduce((n, p) => n + p.x, 0) / fixed.length, y: fixed.reduce((n, p) => n + p.y, 0) / fixed.length } : { x: 0, y: 0 };
  for (const node of nodes) {
    if (anchors[node.id]) continue;
    const parents = springs.flatMap(link => link.source === node.id ? [byId.get(link.target)!] : link.target === node.id ? [byId.get(link.source)!] : []).filter(parent => anchors[parent.id]);
    if (parents.length) { node.x += parents.reduce((n, p) => n + p.x, 0) / parents.length; node.y += parents.reduce((n, p) => n + p.y, 0) / parents.length; }
    else { node.x += center.x; node.y += center.y; }
  }
  for (let tick = 0; tick < 240; tick++) {
    const forces = new Map(nodes.map(node => [node.id, { x: (center.x - node.x) * 0.009 / aspect, y: (center.y - node.y) * 0.009 * aspect }]));
    for (const link of springs) {
      const a = byId.get(link.source)!, b = byId.get(link.target)!;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1, force = (distance - 120) * 0.075;
      const af = forces.get(a.id)!, bf = forces.get(b.id)!;
      af.x += dx / distance * force; af.y += dy / distance * force;
      bf.x -= dx / distance * force; bf.y -= dy / distance * force;
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      let dx = a.x - b.x, dy = a.y - b.y, distance = Math.hypot(dx, dy);
      if (distance < 0.01) { dx = Math.cos(j * 2.4); dy = Math.sin(j * 2.4); distance = 1; }
      const push = Math.max(0, 115 - distance) * 0.13;
      let fx = dx / distance * push, fy = dy / distance * push;
      const ox = ((widths[a.id] ?? 104) + (widths[b.id] ?? 104)) / 2 + 10 - Math.abs(dx), oy = 62 - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (oy < ox) fy += Math.sign(dy || 1) * oy * 0.3;
        else fx += Math.sign(dx || 1) * ox * 0.3;
      }
      const af = forces.get(a.id)!, bf = forces.get(b.id)!;
      af.x += fx; af.y += fy; bf.x -= fx; bf.y -= fy;
    }
    for (const node of nodes) {
      if (anchors[node.id]) continue;
      const force = forces.get(node.id)!;
      node.vx = (node.vx + force.x) * 0.65; node.vy = (node.vy + force.y) * 0.65;
      const speed = Math.hypot(node.vx, node.vy), scale = speed > 8 ? 8 / speed : 1;
      node.x += node.vx * scale; node.y += node.vy * scale;
    }
  }
  return Object.fromEntries(nodes.map(node => [node.id, anchors[node.id] ? { ...anchors[node.id]! } : rounded(node)]));
}

export function questionOffset(index: number, count: number): Point {
  const ring = Math.floor(index / 10), number = Math.min(10, count - ring * 10);
  // The open sector below the parent keeps its short title readable.
  const angle = number === 1 ? -Math.PI / 2 : Math.PI * 0.85 + (index % 10) * (Math.PI * 1.3) / Math.max(1, number - 1);
  const radius = 56 + ring * 24;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** Ignore legacy positions once; current positions and intentional drags are anchors. */
export function graphPositions(graph: KnowledgeGraph, conversations: Conversation[], size: CanvasSize, links: MotionLink[]): Record<string, Point> {
  const current = graph.layoutVersion === GRAPH_LAYOUT_VERSION;
  const positions = conversationPositions(conversations.map(c => c.id), size, links, current ? graph.positions : {}, Object.fromEntries(conversations.map(c => [c.id, labelWidth(c.sourceTitle || c.title)])));
  for (const conversation of conversations) conversation.turns.forEach((turn, index) => {
    const id = nodeKey({ conversationId: conversation.id, turnId: turn.id }), offset = questionOffset(index, conversation.turns.length), parent = positions[conversation.id]!;
    positions[id] = current && graph.positions[id] ? { ...graph.positions[id]! } : { x: parent.x + offset.x, y: parent.y + offset.y };
  });
  return positions;
}

/** Bounded local springs. Temporary displacement never changes saved anchors. */
export class GraphMotion {
  bodies = new Map<string, Body>();
  dragging: string | null = null;
  labelsVisible = true;
  private held: string | null = null;

  sync(nodes: MotionNode[]): boolean {
    const ids = new Set(nodes.map(node => node.id));
    let changed = false;
    for (const id of this.bodies.keys()) if (!ids.has(id)) { this.bodies.delete(id); changed = true; }
    const inputs = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      const old = this.bodies.get(node.id), parent = inputs.get(node.data.ref.conversationId);
      if (!old) {
        this.bodies.set(node.id, { id: node.id, kind: node.data.kind, parent: node.data.ref.conversationId, position: { ...node.position }, home: { ...node.position }, offset: { x: node.position.x - (parent?.position.x ?? 0), y: node.position.y - (parent?.position.y ?? 0) }, velocity: { x: 0, y: 0 }, visible: !node.hidden, expanded: !!node.data.expanded, labelWidth: node.data.labelWidth ?? 104 });
        changed = true; continue;
      }
      if (old.expanded !== !!node.data.expanded) {
        changed = true;
        if (old.kind === 'conversation') this.held = node.data.expanded ? old.id : this.dragging;
      }
      if (old.visible !== !node.hidden) {
        changed = true;
        if (!node.hidden && old.kind === 'question') {
          const origin = this.bodies.get(old.parent)?.position ?? parent?.position;
          if (origin) old.position = { x: origin.x + old.offset.x * 0.45, y: origin.y + old.offset.y * 0.45 };
          old.velocity = { x: 0, y: 0 };
        }
      }
      old.visible = !node.hidden; old.expanded = !!node.data.expanded; old.labelWidth = node.data.labelWidth ?? 104;
    }
    return changed;
  }

  drag(id: string, position: Point) {
    const body = this.bodies.get(id); if (!body) return;
    this.dragging = id; this.held = id; body.position = { ...position }; body.home = { ...position }; body.velocity = { x: 0, y: 0 };
    const parent = this.bodies.get(body.parent);
    if (body.kind === 'question' && parent) body.offset = { x: position.x - parent.position.x, y: position.y - parent.position.y };
  }

  release() { this.dragging = null; this.held = null; }

  step(): number {
    const bodies = [...this.bodies.values()], visible = bodies.filter(body => body.visible);
    const forces = new Map(bodies.map(body => [body.id, { x: 0, y: 0 }]));
    const isFixed = (body: Body) => body.id === this.dragging || body.id === this.held;
    for (const body of bodies) {
      const force = forces.get(body.id)!, parent = this.bodies.get(body.parent);
      if (body.kind === 'question' && parent) {
        const target = { x: parent.position.x + body.offset.x, y: parent.position.y + body.offset.y };
        if (!body.visible) { body.position = target; body.velocity = { x: 0, y: 0 }; continue; }
        force.x += (target.x - body.position.x) * 0.085; force.y += (target.y - body.position.y) * 0.085;
      } else {
        force.x += (body.home.x - body.position.x) * 0.12; force.y += (body.home.y - body.position.y) * 0.12;
      }
    }
    const label = (body: Body) => ({ x: body.position.x + 14, y: body.position.y + 41, width: body.labelWidth, height: 20 });
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!, b = visible[j]!;
      let dx = a.position.x - b.position.x, dy = a.position.y - b.position.y, distance = Math.hypot(dx, dy);
      if (distance < 0.01) { dx = Math.cos(j * 2.4); dy = Math.sin(j * 2.4); distance = 1; }
      const minimum = a.kind === 'conversation' && b.kind === 'conversation' ? 42 : 30;
      const push = Math.max(0, minimum - distance) * 0.65;
      let fx = dx / distance * push, fy = dy / distance * push;
      if (this.labelsVisible) {
        const dotA = { x: a.position.x + 14, y: a.position.y + 14, width: 22, height: 22 }, dotB = { x: b.position.x + 14, y: b.position.y + 14, width: 22, height: 22 };
        const repel = (ab: typeof dotA, bb: typeof dotA) => {
          const lx = ab.x - bb.x, ly = ab.y - bb.y;
          const ox = (ab.width + bb.width) / 2 + 6 - Math.abs(lx), oy = (ab.height + bb.height) / 2 + 6 - Math.abs(ly);
          if (ox > 0 && oy > 0) {
            if (oy < ox) fy += Math.sign(ly || dy || 1) * oy * 0.5;
            else fx += Math.sign(lx || dx || 1) * ox * 0.5;
          }
        };
        if (a.kind === 'conversation') repel(label(a), dotB);
        if (b.kind === 'conversation') repel(dotA, label(b));
        if (a.kind === 'conversation' && b.kind === 'conversation') repel(label(a), label(b));
      }
      const af = forces.get(a.id)!, bf = forces.get(b.id)!;
      if (!isFixed(a)) { af.x += fx; af.y += fy; }
      if (!isFixed(b)) { bf.x -= fx; bf.y -= fy; }
    }
    let speed = 0;
    for (const body of bodies) {
      if (!body.visible || isFixed(body)) continue;
      const force = forces.get(body.id)!;
      body.velocity.x = (body.velocity.x + force.x) * 0.58; body.velocity.y = (body.velocity.y + force.y) * 0.58;
      const length = Math.hypot(body.velocity.x, body.velocity.y), limit = this.dragging ? 18 : 10;
      if (length > limit) { body.velocity.x *= limit / length; body.velocity.y *= limit / length; }
      body.position.x += body.velocity.x; body.position.y += body.velocity.y;
      speed = Math.max(speed, Math.hypot(body.velocity.x, body.velocity.y));
    }
    return speed;
  }

  settle() {
    this.held = null;
    for (const body of this.bodies.values()) body.velocity = { x: 0, y: 0 };
  }

  savedPositions(): Record<string, Point> {
    return Object.fromEntries([...this.bodies.values()].map(body => {
      const parent = this.bodies.get(body.parent);
      const position = body.kind === 'question' && parent ? { x: parent.home.x + body.offset.x, y: parent.home.y + body.offset.y } : body.home;
      return [body.id, rounded(position)];
    }));
  }

  positions(): Record<string, Point> {
    return Object.fromEntries([...this.bodies.values()].map(body => [body.id, rounded(body.position)]));
  }
}
