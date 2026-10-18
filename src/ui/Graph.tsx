import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, useNodesInitialized, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { createPortal } from 'react-dom';
import { FolderOpen, GitFork, Inbox, Network, Plus, Search, X } from 'lucide-react';
import type { ActivePage, AppCommand, AppState, Conversation, KnowledgeGraph, NodeRef, SourceSnapshot } from '../core/types';
import { nodeKey, nodeTags, withWorkspace } from '../core/workspace';
import { snapshotConversation, uid } from '../core/context';
import { questionTitle } from '../core/questions';
import { GraphNavigation } from './GraphNavigation';
import { conversationPositions, GraphMotion, questionOffset } from './graphMotion';
import '@xyflow/react/dist/style.css';
import './graph.css';

type Props = { state: AppState; page: ActivePage | null; run: (c: AppCommand) => Promise<unknown>; onBranch: (sources: SourceSnapshot[]) => void };
type CanvasData = { ref: NodeRef; kind: 'conversation' | 'question'; title: string; fullTitle?: string; question?: string; expanded?: boolean; questionCount?: number };
type CanvasNode = Node<CanvasData, 'canvas'>;

function displayTitle(conversation: Conversation) {
  return Array.from((conversation.sourceTitle || conversation.title || '未命名对话').trim()).slice(0, 15).join('');
}
function CanvasDot({ data, selected }: NodeProps<CanvasNode>) {
  const [hover, setHover] = useState<{ left: number; top: number } | null>(null);
  if (data.kind === 'question') return <div className={'canvas-node question-node' + (selected ? ' selected' : '')} aria-label={data.question} onMouseEnter={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover({ left: Math.max(8, Math.min(rect.right + 10, window.innerWidth - 288)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 190)) }); }} onMouseLeave={() => setHover(null)}>
    <Handle type="target" position={Position.Left} isConnectable={false} /><span className="canvas-dot" />{hover && createPortal(<div className="question-tooltip" role="tooltip" style={hover}>{data.question}</div>, document.body)}
  </div>;
  return <div className={'canvas-node conversation-node' + (data.expanded ? ' expanded' : '') + (selected ? ' selected' : '')} title={data.fullTitle}>
    <Handle type="target" position={Position.Left} isConnectable={false} /><span className="canvas-dot" /><span className="canvas-label">{data.title}</span><Handle type="source" position={Position.Left} isConnectable={false} />
  </div>;
}
const nodeTypes = { canvas: CanvasDot };
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
  const [menu, setMenu] = useState<{ node: NodeRef; x: number; y: number } | null>(null);
  const [tagNode, setTagNode] = useState<NodeRef | null>(null);
  const click = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(click.current), []);

  const conversations = graph.conversationIds.map(id => state.conversations.find(c => c.id === id)).filter((c): c is Conversation => !!c);
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
    const fallback = conversationPositions(graph.conversationIds, window.innerWidth < 760), nextNodes: CanvasNode[] = [], nextEdges: Edge[] = [];
    for (const conversation of conversations) {
      const ref = { conversationId: conversation.id }, position = localPositions[conversation.id] ?? graph.positions[conversation.id] ?? fallback[conversation.id]!, isExpanded = expanded.includes(conversation.id);
      nextNodes.push({ id: conversation.id, type: 'canvas', position, selected: selected === conversation.id, data: { ref, kind: 'conversation', title: displayTitle(conversation), fullTitle: conversation.sourceTitle || conversation.title, expanded: isExpanded, questionCount: conversation.turns.length } });
      conversation.turns.forEach((turn, index) => {
        const questionRef = { conversationId: conversation.id, turnId: turn.id }, id = nodeKey(questionRef), offset = questionOffset(index, conversation.turns.length);
        nextNodes.push({ id, type: 'canvas', hidden: !isExpanded, position: localPositions[id] ?? graph.positions[id] ?? { x: position.x + offset.x, y: position.y + offset.y }, selected: selected === id, data: { ref: questionRef, kind: 'question', title: '', question: questionTitle(turn.user, turn.question) } });
        nextEdges.push({ id: 'question-' + id, hidden: !isExpanded, source: conversation.id, target: id, type: 'straight', style: { stroke: '#c9c7dc', strokeWidth: 1 }, selectable: false });
      });
    }
    const connected = new Set<string>();
    for (const relation of state.relations) {
      const source = relation.source.conversationId, key = source + '>' + relation.targetId;
      if (source && graph.conversationIds.includes(source) && graph.conversationIds.includes(relation.targetId) && !connected.has(key)) {
        connected.add(key); nextEdges.push({ id: 'inherit-' + relation.id, source, target: relation.targetId, type: 'straight', style: { stroke: '#aaa6c3', strokeWidth: 1 }, selectable: false });
      }
    }
    return { nodes: nextNodes, edges: nextEdges };
  }, [state.relations, graph, conversations, expanded, selected, localPositions]);
  const staged = state.staged!.filter(item => item.selected);
  return <section className={'knowledge-workspace ' + (tree ? 'tree-open' : '')} aria-label="知识图工作区">
    {tree && <GraphNavigation state={state} run={run} close={() => setTree(false)} />}
    <div className="knowledge-main">
      <header className="knowledge-header"><div className="graph-title-row"><button className="icon" aria-label={tree ? '收起文库目录' : '展开文库目录'} onClick={() => setTree(!tree)}><FolderOpen size={19} /></button><div><EditableTitle key={graph.id} name={graph.name} save={name => patch({ name })} /><span>{conversations.length} 个对话</span></div></div><div className="graph-actions"><select aria-label="打开方式" value={state.openMode} onChange={event => save({ type: 'openMode.save', mode: event.target.value as 'split' | 'tab' })}><option value="split">分栏打开</option><option value="tab">新标签页</option></select><details className="more-menu"><summary aria-label="添加节点"><Plus size={18} /></summary><div className="menu-popover"><button disabled={!page} onClick={() => save({ type: 'conversation.capture', tabId: page?.tabId })}>收纳当前对话</button><button onClick={() => { setPicker(true); setChosen([]); }}>从对话库添加</button><button onClick={() => onBranch([])}>新建对话节点</button></div></details></div></header>
      <div className="knowledge-canvas">{!conversations.length ? <div className="graph-empty"><Network size={34} /><h2>从一段对话开始</h2><p>收纳当前对话，或从对话库加入节点。</p><button disabled={!page} onClick={() => save({ type: 'conversation.capture', tabId: page?.tabId })}>收纳当前对话</button><button className="text-button" onClick={() => setPicker(true)}>从对话库添加</button></div> : <GraphCanvas nodes={nodes} edges={edges}
        onClick={node => { clearTimeout(click.current); setMenu(null); click.current = setTimeout(() => { setSelected(node.id); if (node.data.kind === 'conversation') toggle(node.id); }, 230); }}
        onDoubleClick={node => { clearTimeout(click.current); setSelected(node.id); setMenu(null); open(node.data.ref); }}
        onMenu={(node, x, y) => { clearTimeout(click.current); setSelected(node.id); setMenu({ node: node.data.ref, x: Math.max(8, Math.min(x, window.innerWidth - 190)), y: Math.max(8, Math.min(y, window.innerHeight - 150)) }); }}
        onPane={() => { setMenu(null); setSelected(null); }}
        onLayout={positions => { setLocalPositions(positions); patch({ positions }); }} />}</div>
      <footer className="graph-footer"><button className="stage-button" onClick={() => setDrawer(!drawer)}><Inbox size={17} />暂存 <span>{state.staged!.length}</span></button><small>单击展开 · 拖动整理 · 双击打开</small></footer>
    </div>
    {drawer && <section className="stage-drawer" aria-label="暂存内容"><header><strong>暂存</strong><button className="icon" aria-label="关闭暂存" onClick={() => setDrawer(false)}><X size={16} /></button></header><div className="stage-items">{!state.staged!.length ? <p>选中节点或右键选中文字，加入暂存。</p> : state.staged!.map(item => <div className="stage-item" key={item.id}><label><input type="checkbox" checked={item.selected} onChange={event => save({ type: 'stage.save', item: { ...item, selected: event.target.checked } })} /><span><strong>{item.source.title}</strong><small>{item.source.text.slice(0, 120)}</small></span></label><button className="icon" title="移除暂存" onClick={() => save({ type: 'stage.delete', id: item.id })}><X size={14} /></button></div>)}</div><button className="primary" disabled={!staged.length} onClick={() => { setDrawer(false); onBranch(staged.map(item => item.source)); }}><GitFork size={15} />用所选内容新建对话</button></section>}
    {menu && createPortal(<div className="node-context-menu" role="menu" aria-label="节点操作" style={{ left: menu.x, top: menu.y }} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
      <button role="menuitem" onClick={() => { stage(menu.node); setMenu(null); }}>加入暂存</button>
      <button role="menuitem" onClick={() => { setTagNode(menu.node); setMenu(null); }}>编辑 Tag</button>
      {!menu.node.turnId && <button role="menuitem" onClick={() => { const conversation = state.conversations.find(item => item.id === menu.node.conversationId); if (conversation) onBranch([snapshotConversation(conversation)]); setMenu(null); }}>新建后续对话</button>}
      <button role="menuitem" onClick={() => setMenu(null)}>关闭</button>
    </div>, document.body)}
    {tagNode && <TagEditor key={nodeKey(tagNode)} state={state} node={tagNode} run={run} close={() => setTagNode(null)} />}
    {picker && <div className="modal-backdrop"><section className="graph-manager" role="dialog" aria-label="从对话库添加"><header><h2>添加对话节点</h2><button className="icon" onClick={() => setPicker(false)}><X size={17} /></button></header><label className="graph-search"><Search size={14} /><input autoFocus placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="picker-items">{state.conversations.filter(item => !graph.conversationIds.includes(item.id) && (!query || item.title.toLowerCase().includes(query.toLowerCase()))).map(item => <label key={item.id}><input type="checkbox" checked={chosen.includes(item.id)} onChange={event => setChosen(event.target.checked ? [...chosen, item.id] : chosen.filter(id => id !== item.id))} />{item.sourceTitle || item.title}</label>)}</div><footer><button className="primary" disabled={!chosen.length} onClick={() => void run({ type: 'graph.add', id: graph.id, conversationIds: chosen }).then(result => { if (result !== undefined) setPicker(false); })}>添加 {chosen.length} 个节点</button></footer></section></div>}
  </section>;
}
function EditableTitle({ name, save }: { name: string; save: (name: string) => void }) {
  const [value, setValue] = useState(name); useEffect(() => setValue(name), [name]);
  return <input aria-label="知识图名称" maxLength={200} value={value} onChange={event => setValue(event.target.value)} onBlur={() => { if (value.trim() && value.trim() !== name) save(value.trim()); else setValue(name); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setValue(name); event.currentTarget.blur(); } }} />;
}

// Keep the viewport and React Flow's measured dimensions while animating only positions.
function GraphCanvas({ nodes: incoming, edges, onClick, onDoubleClick, onMenu, onPane, onLayout }: {
  nodes: CanvasNode[]; edges: Edge[]; onClick: (node: CanvasNode) => void; onDoubleClick: (node: CanvasNode) => void;
  onMenu: (node: CanvasNode, x: number, y: number) => void; onPane: () => void;
  onLayout: (positions: KnowledgeGraph['positions']) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(incoming);
  const motion = useRef(new GraphMotion());
  const frame = useRef<number | null>(null);
  const dirty = useRef(false);
  const commit = useRef(onLayout); commit.current = onLayout;
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animate = useCallback(() => {
    dirty.current = true;
    if (frame.current !== null) return;
    let quiet = 0, ticks = 0, previous = 0;
    const tick = (now: number) => {
      // Bound updates to ~60 Hz even on high refresh-rate displays.
      if (now - previous < 15) { frame.current = requestAnimationFrame(tick); return; }
      previous = now;
      let speed = 0;
      for (let i = 0; i < (reduced.current ? 60 : 1); i++) speed = motion.current.step();
      ticks++; quiet = speed < 0.08 ? quiet + 1 : 0;
      const positions = motion.current.positions();
      setNodes(current => current.map(node => positions[node.id] ? { ...node, position: positions[node.id]! } : node));
      if (!motion.current.dragging && (quiet > 10 || ticks > 240 || reduced.current)) {
        motion.current.settle(); frame.current = null;
        if (dirty.current) { dirty.current = false; commit.current(positions); }
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
    if (changed) animate();
  }, [incoming, setNodes, animate]);
  useEffect(() => {
    if (frame.current === null) animate();
    return () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    // Switching graphs during motion still retains the positions reached so far.
    if (dirty.current) { dirty.current = false; commit.current(motion.current.positions()); }
    };
  }, [animate]);
  return <ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.15} maxZoom={1.6}
    nodesDraggable nodesConnectable={false} elementsSelectable={false} zoomOnDoubleClick={false} onNodesChange={onNodesChange}
    onNodeClick={(_, node) => onClick(node)} onNodeDoubleClick={(_, node) => onDoubleClick(node)}
    onNodeContextMenu={(event, node) => { event.preventDefault(); onMenu(node, event.clientX, event.clientY); }} onPaneClick={onPane}
    onNodeDragStart={(_, node) => { motion.current.drag(node.id, node.position); animate(); }}
    onNodeDrag={(_, node) => { motion.current.drag(node.id, node.position); animate(); }}
    onNodeDragStop={(_, node) => { motion.current.drag(node.id, node.position); motion.current.release(); animate(); }} proOptions={{ hideAttribution: true }}>
    <InitialGraphViewport />
    <Background color="#e3e2ea" gap={24} size={1} /><Controls showInteractive={false} position="bottom-right" />
  </ReactFlow>;
}
function InitialGraphViewport() {
  const initialized = useNodesInitialized();
  const done = useRef(false);
  const { getNodes, setViewport, fitView } = useReactFlow<CanvasNode>();
  useEffect(() => {
    if (!initialized || done.current) return;
    done.current = true;
    const first = getNodes().find(node => node.data.kind === 'conversation');
    if (window.innerWidth < 760 && first) {
      // A wide layout saved in the full workspace must remain legible in a sidebar.
      void setViewport({ x: 44 - first.position.x * 0.9, y: 140 - first.position.y * 0.9, zoom: 0.9 });
    } else void fitView({ padding: 0.25, maxZoom: 1 });
  }, [initialized, getNodes, setViewport, fitView]);
  return null;
}
function TagEditor({ state, node, run, close }: { state: AppState; node: NodeRef; run: Props['run']; close: () => void }) {
  const [tags, setTags] = useState(nodeTags(state, node).join(', '));
  return <div className="modal-backdrop"><form className="graph-manager" role="dialog" aria-label="编辑节点 Tag" onSubmit={event => { event.preventDefault(); void run({ type: 'node.tags', node, tags: tags.split(/[,，]/) }).then(result => { if (result !== undefined) close(); }); }}>
    <header><h2>编辑 Tag</h2><button type="button" className="icon" aria-label="关闭 Tag 编辑" onClick={close}><X size={17} /></button></header>
    <label>Tag<input autoFocus aria-label="节点 Tag" value={tags} onChange={event => setTags(event.target.value)} placeholder="以逗号分隔" list="known-tags" /></label>
    <datalist id="known-tags">{state.tagEntries?.filter(tag => tag.kind === 'tag').map(tag => <option value={tag.name} key={tag.id} />)}</datalist>
    <footer><button type="button" onClick={close}>取消</button><button className="primary" type="submit">保存</button></footer>
  </form></div>;
}
