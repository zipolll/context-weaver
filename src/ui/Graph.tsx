import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, useNodesInitialized, useNodesState, useReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { createPortal } from 'react-dom';
import { FolderOpen, GitFork, Inbox, Network, Plus, Search, X } from 'lucide-react';
import type { ActivePage, AppCommand, AppState, Conversation, KnowledgeGraph, NodeRef, SourceSnapshot } from '../core/types';
import { GRAPH_LAYOUT_VERSION, nodeKey, withWorkspace } from '../core/workspace';
import { primaryTag } from '../core/tags';
import { snapshotConversation, uid } from '../core/context';
import { questionTitle } from '../core/questions';
import { GraphNavigation } from './GraphNavigation';
import { NodeTagPicker } from './NodeTagPicker';
import { DirectedEdge } from './DirectedEdge';
import { graphPositions, GraphMotion, labelWidth, type CanvasSize } from './graphMotion';
import '@xyflow/react/dist/style.css';
import './graph.css';

type Props = { state: AppState; page: ActivePage | null; run: (c: AppCommand) => Promise<unknown>; onBranch: (sources: SourceSnapshot[]) => void };
type CanvasData = { ref: NodeRef; kind: 'conversation' | 'question'; title: string; fullTitle?: string; question?: string; expanded?: boolean; labelWidth?: number; dotSize?: number; color?: string; dimmed?: boolean; emphasized?: boolean; active?: boolean; labelHidden?: boolean; dragging?: boolean; onHover?: (id: string | null) => void; onActivate?: () => void };
type CanvasNode = Node<CanvasData, 'canvas'>;

function displayTitle(conversation: Conversation) {
  return (conversation.sourceTitle || conversation.title || '未命名对话').trim();
}
function QuestionTooltip({ anchor, text, id }: { anchor: HTMLDivElement; text: string; id: string }) {
  const tooltip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const element = tooltip.current;
      if (!element || !anchor.isConnected) return;
      const dot = anchor.getBoundingClientRect(), label = anchor.querySelector('.canvas-label')?.getBoundingClientRect();
      const rect = { left: Math.min(dot.left, label?.left ?? dot.left), right: Math.max(dot.right, label?.right ?? dot.right), top: dot.top, bottom: Math.max(dot.bottom, label?.bottom ?? dot.bottom), width: Math.max(dot.width, label?.width ?? dot.width), height: Math.max(dot.height, (label?.bottom ?? dot.bottom) - dot.top) }, gap = 14, margin = 12;
      const width = Math.min(300, window.innerWidth - margin * 2);
      element.style.width = width + 'px';
      element.style.maxHeight = '240px';
      let height = element.getBoundingClientRect().height;
      const horizontalLeft = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - margin - width));
      const verticalTop = Math.max(margin, Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - margin - height));
      const candidates = [
        { left: rect.right + gap, top: verticalTop },
        { left: rect.left - gap - width, top: verticalTop },
        { left: horizontalLeft, top: rect.bottom + gap },
        { left: horizontalLeft, top: rect.top - gap - height }
      ].filter(point => point.left >= margin && point.top >= margin && point.left + width <= window.innerWidth - margin && point.top + height <= window.innerHeight - margin);
      const neighbours = [...document.querySelectorAll('.canvas-node')].filter(node => node !== anchor).map(node => node.getBoundingClientRect());
      const overlap = (point: { left: number; top: number }) => neighbours.reduce((area, node) => area + Math.max(0, Math.min(point.left + width, node.right + 6) - Math.max(point.left, node.left - 6)) * Math.max(0, Math.min(point.top + height, node.bottom + 6) - Math.max(point.top, node.top - 6)), 0);
      candidates.sort((a, b) => overlap(a) - overlap(b));
      let left: number, top: number;
      if (candidates[0]) ({ left, top } = candidates[0]);
      else {
        // Only shrink vertically when no full-size placement fits. Never clamp
        // the tooltip back onto the question it is describing.
        const above = rect.top - margin - gap, below = window.innerHeight - rect.bottom - margin - gap;
        const useAbove = above > below;
        element.style.maxHeight = Math.max(0, Math.min(240, useAbove ? above : below)) + 'px';
        height = element.getBoundingClientRect().height;
        left = horizontalLeft; top = useAbove ? rect.top - gap - height : rect.bottom + gap;
      }
      element.style.left = left + 'px';
      element.style.top = Math.max(margin, Math.min(top, window.innerHeight - margin - height)) + 'px';
      element.style.visibility = rect.bottom < 0 || rect.top > window.innerHeight ? 'hidden' : 'visible';
    };
    place();
    // Observe actual movement instead of running an idle animation loop.
    const observer = new MutationObserver(place), resize = new ResizeObserver(place);
    for (const element of [anchor.closest('.react-flow__node'), anchor.closest('.react-flow__viewport')]) if (element) observer.observe(element, { attributes: true, attributeFilter: ['style'] });
    resize.observe(anchor); if (tooltip.current) resize.observe(tooltip.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); resize.disconnect(); window.removeEventListener('resize', place); };
  }, [anchor, text]);
  return createPortal(<div ref={tooltip} id={id} className="question-tooltip" role="tooltip" style={{ visibility: 'hidden' }}>{text}</div>, document.body);
}
function CanvasDot({ id, data, selected }: NodeProps<CanvasNode>) {
  const anchor = useRef<HTMLDivElement>(null), tooltipId = useId();
  const [hover, setHover] = useState(false), [focused, setFocused] = useState(false);
  const question = data.kind === 'question', text = question ? data.question ?? '' : data.fullTitle ?? data.title;
  const showTooltip = (hover || focused) && data.active && !data.dragging;
  return <div ref={anchor} role="button" tabIndex={0} className={'canvas-node ' + (question ? 'question-node' : 'conversation-node') + (data.expanded ? ' expanded' : '') + (selected ? ' selected' : '') + (data.dimmed ? ' dimmed' : '') + (data.emphasized ? ' emphasized' : '')}
    style={{ '--dot-size': (data.dotSize ?? 10) + 'px', ...(data.color ? { '--tag-color': data.color, '--tag-halo': data.color + '22' } : {}) } as CSSProperties} data-tagged={data.color ? 'true' : undefined} aria-label={text} aria-expanded={question ? undefined : !!data.expanded} aria-describedby={showTooltip ? tooltipId : undefined}
    onMouseEnter={() => { setHover(true); data.onHover?.(id); }} onMouseLeave={() => { setHover(false); if (!focused) data.onHover?.(null); }}
    onFocus={() => { setFocused(true); data.onHover?.(id); }} onBlur={() => { setFocused(false); if (!hover) data.onHover?.(null); }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); data.onActivate?.(); } }}>
    <Handle type="target" position={Position.Left} isConnectable={false} /><span className="canvas-dot" />
    {!question && <><span className={'canvas-label' + (data.labelHidden ? ' label-hidden' : '')}>{data.title}</span><Handle type="source" position={Position.Left} isConnectable={false} /></>}
    {showTooltip && anchor.current && <QuestionTooltip anchor={anchor.current} text={text} id={tooltipId} />}
  </div>;
}
const nodeTypes = { canvas: CanvasDot };
const edgeTypes = { provenance: DirectedEdge };
// New nodes can arrive between dimension measurement and a background refresh.
// Explicit geometry prevents those refreshes from clearing their handle bounds.
const centeredTarget = { id: null, type: 'target' as const, position: Position.Left, x: 14, y: 14, width: 0, height: 0 };
const conversationGeometry = { initialWidth: 28, initialHeight: 28, handles: [centeredTarget, { ...centeredTarget, type: 'source' as const }] };
const questionGeometry = { initialWidth: 28, initialHeight: 28, handles: [centeredTarget] };
function pointerPosition(event: MouseEvent | TouchEvent) {
  const point = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event;
  return point ? { x: point.clientX, y: point.clientY } : null;
}
export function Graph({ state: raw, page, run, onBranch }: Props) {
  const state = useMemo(() => withWorkspace(raw), [raw]);
  return <GraphWorkspace key={state.activeGraphId} state={state} page={page} run={run} onBranch={onBranch} />;
}
function GraphWorkspace({ state, page, run, onBranch }: Props) {
  const graph = state.graphs!.find(item => item.id === state.activeGraphId)!;
  const [tree, setTree] = useState(() => window.innerWidth >= 760);
  const [drawer, setDrawer] = useState(false);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  // Expansion is local. Motion settles before positions are saved, outside state updaters.
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [localPositions, setLocalPositions] = useState<KnowledgeGraph['positions']>({});
  const canvasArea = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<CanvasSize | null>(null);
  const [menu, setMenu] = useState<{ node: NodeRef; x: number; y: number } | null>(null);
  const [tagNode, setTagNode] = useState<{ node: NodeRef; x: number; y: number } | null>(null);
  const click = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(click.current), []);
  useLayoutEffect(() => {
    const element = canvasArea.current; if (!element) return;
    const measure = () => { const { width, height } = element.getBoundingClientRect(); if (width && height) setSize(previous => previous?.width === width && previous?.height === height ? previous : { width, height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const conversations = useMemo(() => graph.conversationIds.map(id => state.conversations.find(c => c.id === id)).filter((c): c is Conversation => !!c), [graph.conversationIds, state.conversations]);
  const links = useMemo(() => {
    const unique = new Map<string, { source: string; target: string }>();
    for (const relation of state.relations) {
      const source = relation.source.conversationId, target = relation.targetId;
      if (source && source !== target && graph.conversationIds.includes(source) && graph.conversationIds.includes(target)) unique.set(JSON.stringify([source, target]), { source, target });
    }
    return [...unique.values()];
  }, [state.relations, graph.conversationIds]);
  const baseline = useMemo(() => size ? graphPositions(graph, conversations, size, links) : {}, [graph, conversations, size, links]);
  const save = (command: AppCommand) => void run(command);
  const patch = (patchValue: Partial<KnowledgeGraph>) => save({ type: 'graph.patch', id: graph.id, patch: patchValue });
  const toggle = (id: string) => setExpanded(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const open = (ref: NodeRef) => {
    const conversation = state.conversations.find(item => item.id === ref.conversationId);
    if (conversation) save({ type: 'page.open', url: conversation.url, turnId: ref.turnId, mode: state.openMode });
  };
  const stage = (ref: NodeRef) => {
    const conversation = state.conversations.find(item => item.id === ref.conversationId);
    if (!conversation) return;
    let source = snapshotConversation(conversation, ref.turnId);
    if (ref.turnId) {
      const turn = conversation.turns.find(item => item.id === ref.turnId)!;
      source = { ...source, title: questionTitle(turn.user, turn.question), turnIds: [turn.id], turns: [structuredClone(turn)], text: '用户：' + turn.user + '\n助手：' + turn.assistant };
    }
    save({ type: 'stage.save', item: { id: uid(), source, node: ref, selected: true, createdAt: Date.now() } });
  };
  const { nodes, edges } = useMemo(() => {
    const nextNodes: CanvasNode[] = [], nextEdges: Edge[] = [];
    if (!size) return { nodes: nextNodes, edges: nextEdges };
    for (const conversation of conversations) {
      const ref = { conversationId: conversation.id }, position = localPositions[conversation.id] ?? baseline[conversation.id]!, isExpanded = expanded.includes(conversation.id);
      const degree = new Set(links.flatMap(link => link.source === conversation.id ? [link.target] : link.target === conversation.id ? [link.source] : [])).size;
      nextNodes.push({ ...conversationGeometry, id: conversation.id, type: 'canvas', position, focusable: false, selected: selected === conversation.id, data: { ref, kind: 'conversation', title: displayTitle(conversation), fullTitle: displayTitle(conversation), expanded: isExpanded, labelWidth: labelWidth(displayTitle(conversation)), dotSize: Math.min(14, 10 + degree), color: primaryTag(state, ref)?.color } });
      conversation.turns.forEach(turn => {
        const questionRef = { conversationId: conversation.id, turnId: turn.id }, id = nodeKey(questionRef);
        nextNodes.push({ ...questionGeometry, id, type: 'canvas', hidden: !isExpanded, focusable: false, position: localPositions[id] ?? baseline[id]!, selected: selected === id, data: { ref: questionRef, kind: 'question', title: '', question: questionTitle(turn.user, turn.question), color: primaryTag(state, questionRef)?.color } });
        nextEdges.push({ id: 'question-' + id, hidden: !isExpanded, source: conversation.id, target: id, type: 'straight', style: { stroke: '#b4a8c8', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }, selectable: false });
      });
    }
    const connected = new Set<string>();
    for (const relation of state.relations) {
      const source = relation.source.conversationId, key = JSON.stringify([source, relation.targetId]);
      if (source && source !== relation.targetId && graph.conversationIds.includes(source) && graph.conversationIds.includes(relation.targetId) && !connected.has(key)) {
        connected.add(key); nextEdges.push({ id: 'inherit-' + relation.id, source, target: relation.targetId, type: 'provenance', data: { sourceRadius: (nextNodes.find(node => node.id === source)?.data.dotSize ?? 10) / 2, targetRadius: (nextNodes.find(node => node.id === relation.targetId)?.data.dotSize ?? 10) / 2 }, style: { stroke: '#9c91b5', strokeWidth: 1.2, vectorEffect: 'non-scaling-stroke' }, selectable: false });
      }
    }
    return { nodes: nextNodes, edges: nextEdges };
  }, [state.relations, state.tagEntries, state.questionMeta, graph, conversations, expanded, selected, localPositions, baseline, links, size]);
  const staged = state.staged!.filter(item => item.selected);
  return <section className={'knowledge-workspace ' + (tree ? 'tree-open' : '')} aria-label="知识图工作区">
    {tree && <GraphNavigation state={state} run={run} close={() => setTree(false)} />}
    <div className="knowledge-main">
      <header className="knowledge-header"><div className="graph-title-row"><button className="icon" aria-label={tree ? '收起文库目录' : '展开文库目录'} onClick={() => setTree(!tree)}><FolderOpen size={19} /></button><div><EditableTitle key={graph.id} name={graph.name} save={name => patch({ name })} /><span>{conversations.length} 个对话</span></div></div><div className="graph-actions"><select aria-label="打开方式" value={state.openMode} onChange={event => save({ type: 'openMode.save', mode: event.target.value as 'split' | 'tab' })}><option value="split">分栏打开</option><option value="tab">新标签页</option></select><details className="more-menu"><summary aria-label="添加节点"><Plus size={18} /></summary><div className="menu-popover"><button disabled={!page} onClick={() => save({ type: 'conversation.capture', tabId: page?.tabId })}>收纳当前对话</button><button onClick={() => { setPicker(true); setChosen([]); }}>从对话库添加</button><button onClick={() => onBranch([])}>新建对话节点</button></div></details></div></header>
      <div ref={canvasArea} className="knowledge-canvas">{!conversations.length ? <div className="graph-empty"><Network size={34} /><h2>从一段对话开始</h2><p>收纳当前对话，或从对话库加入节点。</p><button disabled={!page} onClick={() => save({ type: 'conversation.capture', tabId: page?.tabId })}>收纳当前对话</button><button className="text-button" onClick={() => setPicker(true)}>从对话库添加</button></div> : size && <GraphCanvas nodes={nodes} edges={edges} needsSave={graph.layoutVersion !== GRAPH_LAYOUT_VERSION || nodes.some(node => !graph.positions[node.id])}
        onClick={node => { clearTimeout(click.current); setMenu(null); click.current = setTimeout(() => { setSelected(node.id); if (node.data.kind === 'conversation') toggle(node.id); }, 230); }}
        onDoubleClick={node => { clearTimeout(click.current); setSelected(node.id); setMenu(null); open(node.data.ref); }}
        onMenu={(node, x, y) => { clearTimeout(click.current); setSelected(node.id); setMenu({ node: node.data.ref, x: Math.max(8, Math.min(x, window.innerWidth - 190)), y: Math.max(8, Math.min(y, window.innerHeight - 150)) }); }}
        onPane={() => { setMenu(null); setSelected(null); }}
        onLayout={positions => { setLocalPositions(positions); patch({ positions, layoutVersion: GRAPH_LAYOUT_VERSION }); }} />}</div>
      <footer className="graph-footer"><button className="stage-button" onClick={() => setDrawer(!drawer)}><Inbox size={17} />暂存 <span>{state.staged!.length}</span></button><small>单击展开 · 拖动整理 · 双击打开</small></footer>
    </div>
    {drawer && <section className="stage-drawer" aria-label="暂存内容"><header><strong>暂存</strong><button className="icon" aria-label="关闭暂存" onClick={() => setDrawer(false)}><X size={16} /></button></header><div className="stage-items">{!state.staged!.length ? <p>选中节点或右键选中文字，加入暂存。</p> : state.staged!.map(item => <div className="stage-item" key={item.id}><label><input type="checkbox" checked={item.selected} onChange={event => save({ type: 'stage.save', item: { ...item, selected: event.target.checked } })} /><span><strong>{item.source.title}</strong><small>{item.source.text.slice(0, 120)}</small></span></label><button className="icon" title="移除暂存" onClick={() => save({ type: 'stage.delete', id: item.id })}><X size={14} /></button></div>)}</div><button className="primary" disabled={!staged.length} onClick={() => { setDrawer(false); onBranch(staged.map(item => item.source)); }}><GitFork size={15} />用所选内容新建对话</button></section>}
    {menu && createPortal(<div className="node-context-menu" role="menu" aria-label="节点操作" style={{ left: menu.x, top: menu.y }} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
      <button role="menuitem" onClick={() => { stage(menu.node); setMenu(null); }}>加入暂存</button>
      <button role="menuitem" onClick={() => { setTagNode(menu); setMenu(null); }}>选择 Tag</button>
      {!menu.node.turnId && <button role="menuitem" onClick={() => { const conversation = state.conversations.find(item => item.id === menu.node.conversationId); if (conversation) onBranch([snapshotConversation(conversation)]); setMenu(null); }}>新建后续对话</button>}
      <button role="menuitem" onClick={() => setMenu(null)}>关闭</button>
    </div>, document.body)}
    {tagNode && <NodeTagPicker key={nodeKey(tagNode.node)} state={state} node={tagNode.node} x={tagNode.x} y={tagNode.y} run={run} close={() => setTagNode(null)} />}
    {picker && <div className="modal-backdrop"><section className="graph-manager" role="dialog" aria-label="从对话库添加"><header><h2>添加对话节点</h2><button className="icon" onClick={() => setPicker(false)}><X size={17} /></button></header><label className="graph-search"><Search size={14} /><input autoFocus placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="picker-items">{state.conversations.filter(item => !graph.conversationIds.includes(item.id) && (!query || item.title.toLowerCase().includes(query.toLowerCase()))).map(item => <label key={item.id}><input type="checkbox" checked={chosen.includes(item.id)} onChange={event => setChosen(event.target.checked ? [...chosen, item.id] : chosen.filter(id => id !== item.id))} />{item.sourceTitle || item.title}</label>)}</div><footer><button className="primary" disabled={!chosen.length} onClick={() => void run({ type: 'graph.add', id: graph.id, conversationIds: chosen }).then(result => { if (result !== undefined) setPicker(false); })}>添加 {chosen.length} 个节点</button></footer></section></div>}
  </section>;
}
function EditableTitle({ name, save }: { name: string; save: (name: string) => void }) {
  const [value, setValue] = useState(name); useEffect(() => setValue(name), [name]);
  return <input aria-label="知识图名称" maxLength={200} value={value} onChange={event => setValue(event.target.value)} onBlur={() => { if (value.trim() && value.trim() !== name) save(value.trim()); else setValue(name); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setValue(name); event.currentTarget.blur(); } }} />;
}

// Keep the viewport and React Flow's measured dimensions while animating only positions.
function GraphCanvas({ nodes: incoming, edges, needsSave, onClick, onDoubleClick, onMenu, onPane, onLayout }: {
  nodes: CanvasNode[]; edges: Edge[]; onClick: (node: CanvasNode) => void; onDoubleClick: (node: CanvasNode) => void;
  needsSave: boolean;
  onMenu: (node: CanvasNode, x: number, y: number) => void; onPane: () => void;
  onLayout: (positions: KnowledgeGraph['positions']) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(incoming);
  const [hovered, setHovered] = useState<string | null>(null);
  const [labelScale, setLabelScale] = useState(1);
  const motion = useRef(new GraphMotion());
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointer: { x: number; y: number }; position: { x: number; y: number } } | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | null>(null);
  const dirty = useRef(false);
  const commit = useRef(onLayout); commit.current = onLayout;
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const centerNode = (node: CanvasNode) => {
    const instance = flow.current; if (!instance) return;
    const position = motion.current.bodies.get(node.id)?.position ?? node.position;
    void instance.setCenter(position.x + 14, position.y + 14, { zoom: instance.getZoom(), duration: reduced.current ? 0 : 300 });
  };
  const animate = useCallback((persist = false) => {
    dirty.current ||= persist;
    if (frame.current !== null) return;
    let quiet = 0, ticks = 0, previous = 0;
    const tick = (now: number) => {
      // Bound updates to ~60 Hz even on high refresh-rate displays.
      if (now - previous < 15) { frame.current = requestAnimationFrame(tick); return; }
      previous = now;
      let speed = 0;
      for (let i = 0; i < (reduced.current ? 180 : 1); i++) speed = motion.current.step();
      ticks++; quiet = speed < 0.08 ? quiet + 1 : 0;
      if (drag.current && flow.current && surface.current) {
        const active = drag.current, viewport = flow.current.getViewport();
        const x = (active.position.x + 14) * viewport.zoom + viewport.x, y = (active.position.y + 14) * viewport.zoom + viewport.y;
        const margin = Math.min(70, surface.current.clientWidth / 5);
        const dx = Math.max(margin, Math.min(x, surface.current.clientWidth - margin)) - x;
        const dy = Math.max(margin, Math.min(y, surface.current.clientHeight - margin)) - y;
        // Pointer deltas drive world position, so camera movement cannot feed back
        // into the drag and send the node racing away from the pointer.
        if (Math.abs(dx) + Math.abs(dy) > 0.5) void flow.current.setViewport({ ...viewport, x: viewport.x + dx * 0.2, y: viewport.y + dy * 0.2 });
      }
      const positions = motion.current.positions();
      setNodes(current => current.map(node => positions[node.id] ? { ...node, position: positions[node.id]! } : node));
      if (!motion.current.dragging && (quiet > 3 || ticks > 120 || reduced.current)) {
        motion.current.settle(); frame.current = null;
        if (dirty.current) { dirty.current = false; commit.current(motion.current.savedPositions()); }
      } else frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [setNodes]);
  useEffect(() => {
    const changed = motion.current.sync(incoming), positions = motion.current.positions();
    setNodes(previous => {
      const cached = new Map(previous.map(node => [node.id, node]));
      return incoming.map(node => { const old = cached.get(node.id); return { ...old, ...node, position: positions[node.id] ?? node.position, measured: old?.measured }; });
    });
    if (changed) animate(needsSave);
  }, [incoming, setNodes, animate, needsSave]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { reduced.current = media.matches; if (media.matches) animate(); };
    media.addEventListener('change', change);
    return () => {
    media.removeEventListener('change', change);
    clearTimeout(focusTimer.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    // Persist intentional anchors, never temporary expansion displacement.
    if (dirty.current) { dirty.current = false; commit.current(motion.current.savedPositions()); }
    };
  }, [animate]);
  const updateZoom = (zoom: number) => {
    surface.current?.style.setProperty('--graph-label-opacity', String(Math.max(0, Math.min(1, (zoom - 0.55) / 0.3))));
    motion.current.labelsVisible = zoom > 0.55;
    setLabelScale(Math.round(zoom * 40) / 40);
  };
  const active = hovered ?? nodes.find(node => node.selected)?.id;
  const neighbours = new Set(active ? [active] : []);
  if (active) for (const edge of edges) if (!edge.hidden) {
    if (edge.source === active) neighbours.add(edge.target);
    if (edge.target === active) neighbours.add(edge.source);
  }
  // Give crowded labels space on screen rather than pushing the graph apart.
  // Direct neighbours stay readable during an explicit hover or selection.
  const labelBoxes: { x: number; y: number; width: number; height: number }[] = [], shownLabels = new Set<string>();
  const labels = nodes.filter(node => node.data.kind === 'conversation').sort((a, b) => Number(neighbours.has(b.id)) - Number(neighbours.has(a.id)) || (b.data.dotSize ?? 10) - (a.data.dotSize ?? 10) || a.id.localeCompare(b.id));
  for (const node of labels) {
    const width = (node.data.labelWidth ?? 104) * labelScale, box = { x: (node.position.x + 14) * labelScale - width / 2, y: (node.position.y + 31) * labelScale, width, height: 20 * labelScale };
    const collision = labelBoxes.some(other => box.x < other.x + other.width + 5 && box.x + box.width + 5 > other.x && box.y < other.y + other.height + 4 && box.y + box.height + 4 > other.y);
    if (neighbours.has(node.id) || !collision) { shownLabels.add(node.id); labelBoxes.push(box); }
  }
  const visibleNodes = nodes.map(node => ({ ...node, data: { ...node.data, dimmed: !!active && !neighbours.has(node.id), emphasized: !!active && neighbours.has(node.id), active: node.id === active, labelHidden: !shownLabels.has(node.id), dragging: !!drag.current,
    onHover: setHovered, onActivate: () => { onClick(node); centerNode(node); } } }));
  const visibleEdges = edges.map(edge => ({ ...edge, style: { ...edge.style, opacity: active ? edge.source === active || edge.target === active ? 0.9 : 0.12 : 0.48, ...(active && (edge.source === active || edge.target === active) ? { stroke: '#8064d8', strokeWidth: 1.5 } : {}) } }));
  return <ReactFlow<CanvasNode> ref={surface} onInit={instance => { flow.current = instance; updateZoom(instance.getZoom()); }} onMove={(_, viewport) => updateZoom(viewport.zoom)} nodes={visibleNodes} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={0.15} maxZoom={1.6} autoPanOnNodeDrag={false} fitViewOptions={{ padding: 0.3, minZoom: 0.25, maxZoom: 1.1 }}
    nodesDraggable nodesConnectable={false} elementsSelectable={false} zoomOnDoubleClick={false} onNodesChange={changes => onNodesChange(changes.filter(change => change.type !== 'position'))}
    onNodeClick={(_, node) => { clearTimeout(focusTimer.current); onClick(node); focusTimer.current = setTimeout(() => centerNode(node), 230); }} onNodeDoubleClick={(_, node) => { clearTimeout(focusTimer.current); onDoubleClick(node); }}
    onNodeContextMenu={(event, node) => { clearTimeout(focusTimer.current); event.preventDefault(); onMenu(node, event.clientX, event.clientY); }} onPaneClick={() => { clearTimeout(focusTimer.current); setHovered(null); onPane(); }}
    onNodeDragStart={(event, node) => {
      clearTimeout(focusTimer.current);
      const pointer = pointerPosition(event); if (!pointer) return;
      drag.current = { id: node.id, pointer, position: { ...node.position } };
      if (flow.current) void flow.current.setViewport(flow.current.getViewport());
      setHovered(null); motion.current.drag(node.id, node.position); animate(true);
    }}
    onNodeDrag={(event, node) => {
      const active = drag.current, pointer = pointerPosition(event); if (!active || !pointer) return;
      const zoom = flow.current?.getZoom() ?? 1;
      active.position = { x: active.position.x + (pointer.x - active.pointer.x) / zoom, y: active.position.y + (pointer.y - active.pointer.y) / zoom };
      active.pointer = pointer;
      motion.current.drag(node.id, active.position); animate(true);
    }}
    onNodeDragStop={(_, node) => {
      motion.current.drag(node.id, drag.current?.position ?? node.position); drag.current = null;
      motion.current.release(); animate(true);
    }} proOptions={{ hideAttribution: true }}>
    <InitialGraphViewport />
    <Background color="#e5e3eb" gap={24} size={0.55} /><Controls showInteractive={false} position="bottom-right" />
  </ReactFlow>;
}
function InitialGraphViewport() {
  const initialized = useNodesInitialized();
  const done = useRef(false);
  const { fitView } = useReactFlow<CanvasNode>();
  useEffect(() => {
    if (!initialized || done.current) return;
    done.current = true;
    void fitView({ padding: 0.3, minZoom: 0.25, maxZoom: 1.1 });
  }, [initialized, fitView]);
  return null;
}
