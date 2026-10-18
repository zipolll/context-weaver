export type Point = { x: number; y: number };
export type MotionNode = { id: string; position: Point; hidden?: boolean; data: { kind: 'conversation' | 'question'; ref: { conversationId: string }; expanded?: boolean; questionCount?: number } };
type Body = { id: string; kind: 'conversation' | 'question'; parent: string; position: Point; home: Point; offset: Point; velocity: Point; visible: boolean; expanded: boolean; count: number };

/** Stable seeds: adding or expanding a conversation never reflows existing seeds. */
export function conversationPositions(ids: string[], narrow: boolean): Record<string, Point> {
  const columns = narrow ? 1 : 3;
  return Object.fromEntries(ids.map((id, index) => [id, { x: 80 + (index % columns) * 350 + (Math.floor(index / columns) % 2) * 28, y: 100 + Math.floor(index / columns) * 220 }]));
}

export function questionOffset(index: number, count: number): Point {
  const ring = Math.floor(index / 9), number = Math.min(9, count - ring * 9);
  // Leave a gap on the right for the conversation's title.
  const angle = number === 1 ? Math.PI / 2 : Math.PI / 3 + (index % 9) * (Math.PI * 4 / 3) / (number - 1);
  const radius = 96 + ring * 52;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius + 4 };
}

/** Local, bounded spring simulation. It never changes the viewport or writes storage. */
export class GraphMotion {
  bodies = new Map<string, Body>();
  dragging: string | null = null;
  private held: string | null = null;

  sync(nodes: MotionNode[]): boolean {
    const ids = new Set(nodes.map(node => node.id));
    let changed = false;
    for (const id of this.bodies.keys()) if (!ids.has(id)) { this.bodies.delete(id); changed = true; }
    const inputs = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      const old = this.bodies.get(node.id), parent = inputs.get(node.data.ref.conversationId);
      if (!old) {
        this.bodies.set(node.id, { id: node.id, kind: node.data.kind, parent: node.data.ref.conversationId, position: { ...node.position }, home: { ...node.position }, offset: { x: node.position.x - (parent?.position.x ?? 0), y: node.position.y - (parent?.position.y ?? 0) }, velocity: { x: 0, y: 0 }, visible: !node.hidden, expanded: !!node.data.expanded, count: node.data.questionCount ?? 0 });
        changed = true;
        continue;
      }
      if (old.expanded !== !!node.data.expanded || old.count !== (node.data.questionCount ?? 0)) {
        changed = true;
        if (old.kind === 'conversation') this.held = old.id;
      }
      if (old.visible !== !node.hidden) {
        changed = true;
        if (!node.hidden && old.kind === 'question') {
          const origin = this.bodies.get(old.parent)?.position ?? parent?.position;
          if (origin) old.position = { x: origin.x + old.offset.x * 0.45, y: origin.y + old.offset.y * 0.45 };
          old.velocity = { x: 0, y: 0 };
        }
      }
      old.visible = !node.hidden; old.expanded = !!node.data.expanded; old.count = node.data.questionCount ?? 0;
    }
    return changed;
  }

  drag(id: string, position: Point) {
    const body = this.bodies.get(id); if (!body) return;
    this.dragging = id; this.held = id; body.position = { ...position }; body.home = { ...position }; body.velocity = { x: 0, y: 0 };
    const parent = this.bodies.get(body.parent);
    if (body.kind === 'question' && parent) body.offset = { x: position.x - parent.position.x, y: position.y - parent.position.y };
  }

  release() { this.dragging = null; }

  step(): number {
    const bodies = [...this.bodies.values()], visible = bodies.filter(body => body.visible);
    const forces = new Map(bodies.map(body => [body.id, { x: 0, y: 0 }]));
    const isFixed = (body: Body) => body.id === this.dragging || body.id === this.held;
    for (const body of bodies) {
      const force = forces.get(body.id)!, parent = this.bodies.get(body.parent);
      if (body.kind === 'question' && parent) {
        const target = { x: parent.position.x + body.offset.x, y: parent.position.y + body.offset.y };
        if (!body.visible) { body.position = target; body.velocity = { x: 0, y: 0 }; continue; }
        force.x += (target.x - body.position.x) * 0.018; force.y += (target.y - body.position.y) * 0.018;
      } else {
        force.x += (body.home.x - body.position.x) * 0.002; force.y += (body.home.y - body.position.y) * 0.002;
      }
    }
    // An expanded conversation reserves breathing room for its question cluster.
    const bounds = (body: Body, cluster: boolean) => {
      const radius = cluster && body.expanded ? Math.min(250, 150 + Math.floor(Math.max(0, body.count - 1) / 9) * 52) : 0;
      const width = body.kind === 'conversation' ? 264 : 28, height = body.kind === 'conversation' ? 40 : 28;
      return { x: body.position.x + (width - radius) / 2, y: body.position.y + height / 2, width: width + radius, height: height + radius * 2 };
    };
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!, b = visible[j]!;
      const bothConversations = a.kind === 'conversation' && b.kind === 'conversation';
      const ab = bounds(a, bothConversations), bb = bounds(b, bothConversations);
      const gapX = bothConversations ? 48 : 20, gapY = bothConversations ? 56 : 24;
      const rx = (ab.width + bb.width) / 2 + gapX, ry = (ab.height + bb.height) / 2 + gapY;
      let dx = ab.x - bb.x, dy = ab.y - bb.y;
      if (Math.abs(dx) > rx || Math.abs(dy) > ry) continue;
      // A soft rectangular collision also protects long labels, including corners.
      const overlapX = rx - Math.abs(dx), overlapY = ry - Math.abs(dy);
      if (Math.abs(dx) + Math.abs(dy) < 0.01) dy = i % 2 ? 1 : -1;
      const vertical = overlapY < overlapX;
      const push = Math.min(12, (vertical ? overlapY : overlapX) * 0.13);
      const fx = vertical ? 0 : Math.sign(dx || 1) * push, fy = vertical ? Math.sign(dy || 1) * push : 0;
      const af = forces.get(a.id)!, bf = forces.get(b.id)!;
      if (!isFixed(a)) { af.x += fx; af.y += fy; }
      if (!isFixed(b)) { bf.x -= fx; bf.y -= fy; }
    }
    let speed = 0;
    for (const body of bodies) {
      if (!body.visible || isFixed(body)) continue;
      const force = forces.get(body.id)!;
      body.velocity.x = (body.velocity.x + force.x) * 0.76; body.velocity.y = (body.velocity.y + force.y) * 0.76;
      const length = Math.hypot(body.velocity.x, body.velocity.y), limit = 10;
      if (length > limit) { body.velocity.x *= limit / length; body.velocity.y *= limit / length; }
      body.position.x += body.velocity.x; body.position.y += body.velocity.y;
      speed = Math.max(speed, Math.hypot(body.velocity.x, body.velocity.y));
    }
    return speed;
  }

  settle() {
    this.held = null;
    for (const body of this.bodies.values()) {
      body.home = { ...body.position }; body.velocity = { x: 0, y: 0 };
      const parent = this.bodies.get(body.parent);
      if (body.kind === 'question' && parent) body.offset = { x: body.position.x - parent.position.x, y: body.position.y - parent.position.y };
    }
  }

  positions(): Record<string, Point> {
    return Object.fromEntries([...this.bodies.values()].map(body => [body.id, { x: Math.round(body.position.x * 100) / 100, y: Math.round(body.position.y * 100) / 100 }]));
  }
}
