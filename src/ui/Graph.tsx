import { useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Archive, GitBranch, Link2, MousePointer2 } from 'lucide-react';
import type { AppState } from '../core/types';
import '@xyflow/react/dist/style.css';
import './graph.css';

interface GraphProps {
  state: AppState;
  selected: string[];
  onToggle: (id: string) => void;
  onBranch: (ids: string[]) => void;
}
type ConversationData = {
  title: string;
  subtitle: string;
  url: string;
  archived: boolean;
  ghost: boolean;
  onKeySelect: (id: string, additive: boolean) => void;
};
type ConversationNode = Node<ConversationData, 'conversation'>;

function safeSourceUrl(url: string): string | undefined {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
}

function ConversationCard({ id, data, selected }: NodeProps<ConversationNode>) {
  const href = safeSourceUrl(data.url);
  return <div className={'cw-graph-node' + (selected ? ' is-selected' : '') + (data.archived ? ' is-archived' : '') + (data.ghost ? ' is-ghost' : '')}
    role={data.ghost ? 'group' : 'button'} tabIndex={data.ghost ? -1 : 0}
    aria-label={data.title + (data.ghost ? '，来源已移除' : selected ? '，已选择' : '，未选择')}
    aria-pressed={data.ghost ? undefined : selected}
    onKeyDown={event => {
      if (!data.ghost && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); data.onKeySelect(id, event.ctrlKey || event.metaKey || event.shiftKey); }
    }}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <div className="cw-graph-node-label"><span className="cw-graph-node-dot" />{data.ghost ? '来源已移除' : data.archived ? <><Archive size={11} /> 已归档</> : '对话'}</div>
    <div className="cw-graph-node-title" title={data.title}>{data.title}</div>
    <div className="cw-graph-node-subtitle">{data.subtitle}</div>
    {data.ghost && href && <a className="cw-graph-source-link nodrag nopan" href={href} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()} title={href}><Link2 size={11} />打开原始链接</a>}
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </div>;
}
const nodeTypes = { conversation: ConversationCard };

function graphLayout(state: AppState): { records: Map<string, Omit<ConversationData, 'onKeySelect'>>; positions: Map<string, { x: number; y: number }>; edges: Edge[] } {
  const conversations = new Map(state.conversations.map(conversation => [conversation.id, conversation]));
  const records = new Map<string, Omit<ConversationData, 'onKeySelect'>>();
  for (const conversation of state.conversations) records.set(conversation.id, {
    title: conversation.title || '未命名对话', subtitle: conversation.site + ' · ' + conversation.turns.length + ' 轮', url: conversation.url, archived: conversation.archived, ghost: false,
  });
  const relationLinks = state.relations.filter(relation => conversations.has(relation.targetId)).map(relation => {
    let sourceId = relation.source.conversationId;
    if (!sourceId || !conversations.has(sourceId)) {
      sourceId = 'source-snapshot:' + relation.source.id;
      records.set(sourceId, { title: relation.source.title || '已移除的来源', subtitle: '保留创建分支时的文本快照', url: relation.source.url, archived: false, ghost: true });
    }
    return { relation, sourceId, targetId: relation.targetId };
  });
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const depth = new Map<string, number>();
  for (const id of records.keys()) { parents.set(id, new Set()); children.set(id, new Set()); depth.set(id, 0); }
  for (const link of relationLinks) {
    if (link.sourceId === link.targetId) continue;
    parents.get(link.targetId)!.add(link.sourceId); children.get(link.sourceId)!.add(link.targetId);
  }
  const pending = new Map([...parents].map(([id, ids]) => [id, ids.size]));
  const queue = [...records.keys()].filter(id => pending.get(id) === 0);
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!; visited.add(id);
    for (const target of children.get(id)!) {
      depth.set(target, Math.max(depth.get(target)!, depth.get(id)! + 1));
      pending.set(target, pending.get(target)! - 1);
      if (pending.get(target) === 0) queue.push(target);
    }
  }
  // Imported legacy cycles remain visible without making the layout recurse forever.
  const lastDepth = Math.max(0, ...depth.values());
  for (const id of records.keys()) if (!visited.has(id)) depth.set(id, lastDepth + 1);
  const levels = new Map<number, string[]>();
  for (const id of records.keys()) { const level = depth.get(id)!; const row = levels.get(level) ?? []; row.push(id); levels.set(level, row); }
  const widest = Math.max(1, ...[...levels.values()].map(level => level.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of levels) ids.forEach((id, index) => positions.set(id, { x: (index + (widest - ids.length) / 2) * 264, y: level * 224 }));
  const edges: Edge[] = relationLinks.map(({ relation, sourceId, targetId }) => ({
    id: relation.id, source: sourceId, target: targetId, type: 'smoothstep',
    label: (parents.get(targetId)?.size ?? 0) > 1 ? '汇合' : '分支',
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#738d98' },
    style: { stroke: '#8ba3ad', strokeWidth: 1.5, strokeDasharray: records.get(sourceId)?.ghost ? '5 4' : undefined },
    labelStyle: { fill: '#62747c', fontSize: 11 }, labelBgStyle: { fill: '#f7fafb', fillOpacity: 0.96 }, labelBgPadding: [6, 4],
    selectable: false,
  }));
  return { records, positions, edges };
}

export function Graph({ state, selected, onToggle, onBranch }: GraphProps) {
  const layout = useMemo(() => graphLayout(state), [state.conversations, state.relations]);
  const selectedIds = selected.filter(id => state.conversations.some(conversation => conversation.id === id));
  const select = (id: string, additive: boolean) => {
    if (layout.records.get(id)?.ghost) return;
    if (additive) { onToggle(id); return; }
    for (const current of selectedIds) if (current !== id) onToggle(current);
    if (!selectedIds.includes(id)) onToggle(id);
  };
  const nodes: ConversationNode[] = [...layout.records].map(([id, data]) => ({
    id, type: 'conversation', data: { ...data, onKeySelect: select }, position: layout.positions.get(id)!, selected: !data.ghost && selectedIds.includes(id),
    draggable: false, connectable: false, selectable: !data.ghost, focusable: false, ariaLabel: data.title,
  }));
  if (!state.conversations.length) return <div className="cw-graph cw-graph-empty"><GitBranch size={32} strokeWidth={1.4} /><h3>从一段对话开始</h3><p>收纳对话后，在这里查看来源关系。选择多个节点，可以合并上下文开启新对话。</p></div>;
  return <section className="cw-graph" aria-label="对话来源关系图">
    <div className="cw-graph-toolbar"><span><GitBranch size={15} />{state.conversations.length} 个对话<span className="cw-graph-selection-count">已选 {selectedIds.length}</span></span><button type="button" disabled={!selectedIds.length} onClick={() => onBranch(selectedIds)}>从所选节点新建</button></div>
    <div className="cw-graph-canvas">
      <ReactFlow<ConversationNode> nodes={nodes} edges={layout.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2, minZoom: 0.25, maxZoom: 1 }} minZoom={0.12} maxZoom={1.8}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnDoubleClick={false} preventScrolling
        onNodeClick={(event, node) => select(node.id, event.ctrlKey || event.metaKey || event.shiftKey)}
        proOptions={{ hideAttribution: true }}>
        <Background color="#d5e0e5" gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap position="bottom-right" pannable zoomable nodeColor={node => node.selected ? '#0891b2' : node.data.ghost ? '#dce1e5' : '#a7bdc5'} />
      </ReactFlow>
    </div>
    <p className="cw-graph-help"><MousePointer2 size={12} />Ctrl / ⌘ + 点击多选 · 拖动空白处平移 · 来源箭头指向新对话</p>
  </section>;
}
