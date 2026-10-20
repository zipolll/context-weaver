import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Plus, Search, X } from 'lucide-react';
import type { AppCommand, AppState, NodeRef } from '../core/types';
import { nodeTags } from '../core/workspace';
import { primaryTag } from '../core/tags';
import { uid } from '../core/context';

export function NodeTagPicker({ state, node, x, y, run, close }: { state: AppState; node: NodeRef; x: number; y: number; run: (command: AppCommand) => Promise<unknown>; close: () => void }) {
  const panel = useRef<HTMLElement>(null), pending = useRef(false), radioGroup = useId();
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const savedTags = nodeTags(state, node), savedPrimary = primaryTag(state, node), entries = state.tagEntries!.filter(tag => tag.kind === 'tag');
  const [tags, setTags] = useState(savedTags), [primaryId, setPrimaryId] = useState(savedPrimary?.id);
  const primary = entries.find(tag => tag.id === primaryId);
  useEffect(() => { if (!pending.current) { setTags(savedTags); setPrimaryId(savedPrimary?.id); } }, [savedTags, savedPrimary?.id]);
  const search = query.trim(), visible = entries.filter(tag => tag.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  useLayoutEffect(() => {
    const position = () => {
      const element = panel.current; if (!element) return;
      const box = element.getBoundingClientRect();
      element.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + 'px';
      element.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + 'px';
    };
    position(); const observer = new ResizeObserver(position); if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', position); return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [x, y]);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as globalThis.Node)) closeRef.current(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab' && panel.current) {
        const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const update = async (next: string[], primaryTagId?: string) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    const nextPrimary = primaryTagId ?? (primary && next.includes(primary.name) ? primary.id : entries.find(tag => tag.name === next[0])?.id);
    setTags(next); setPrimaryId(nextPrimary);
    try { if (await run({ type: 'node.tags', node, tags: next, ...(primaryTagId ? { primaryTagId } : {}) }) === undefined) throw new Error('Tag 未保存，请重试。'); }
    catch (caught) { setTags(savedTags); setPrimaryId(savedPrimary?.id); setError((caught as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  const create = async () => {
    if (!search || pending.current || tags.length >= 50) return; pending.current = true; setBusy(true); setError('');
    const tag = { id: uid(), name: search, kind: 'tag' as const, parentId: null };
    try {
      if (await run({ type: 'tag.save', tag }) === undefined) throw new Error('Tag 未保存，请重试。');
      setTags([...tags, tag.name]); setPrimaryId(primary?.id ?? tag.id);
      if (await run({ type: 'node.tags', node, tags: [...tags, tag.name], primaryTagId: primary?.id ?? tag.id }) === undefined) throw new Error('Tag 已创建，添加到节点失败，请重试。');
      setQuery('');
    } catch (caught) { setTags(savedTags); setPrimaryId(savedPrimary?.id); setError((caught as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  return createPortal(<section ref={panel} role="dialog" aria-label="选择节点 Tag" aria-busy={busy} className="node-tag-picker" style={{ left: x, top: y }}>
    <header><div><strong>节点 Tag</strong><small>可多选 · 选择一种主色</small></div><button className="icon" aria-label="关闭 Tag 选择" onClick={close}><X size={16} /></button></header>
    <label className="tag-picker-search"><Search size={14} /><input autoFocus aria-label="搜索或新建 Tag" placeholder="搜索或新建 Tag" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && search && !entries.some(tag => tag.name === search)) { event.preventDefault(); void create(); } }} /></label>
    <div className="tag-picker-heading"><span>Tag</span><span>主色</span></div>
    <div className="tag-picker-list">{visible.map(tag => {
      const checked = tags.includes(tag.name);
      return <div className={'tag-picker-row' + (checked ? ' checked' : '')} key={tag.id}>
        <label><input type="checkbox" aria-label={'选择 Tag ' + tag.name} checked={checked} disabled={busy || (!checked && tags.length >= 50)} onChange={() => void update(checked ? tags.filter(name => name !== tag.name) : [...tags, tag.name])} /><i className="tag-dot" style={{ background: tag.color }} /><span>{tag.name}</span></label>
        <label className="tag-primary-choice" title={checked ? '用此 Tag 的颜色显示节点' : '先选择此 Tag'}><input type="radio" name={radioGroup} aria-label={'将 ' + tag.name + ' 设为主色'} checked={primary?.id === tag.id} disabled={busy || !checked} onChange={() => void update(tags, tag.id)} /><span className="tag-primary-mark">{primary?.id === tag.id && <Check size={12} />}</span></label>
      </div>;
    })}{!visible.length && <p className="tag-picker-empty">{search ? '没有匹配的 Tag' : '添加一个 Tag，用颜色整理节点'}</p>}</div>
    {search && !entries.some(tag => tag.name === search) && <button className="tag-picker-create" disabled={busy || tags.length >= 50} onClick={() => void create()}><Plus size={14} /><span>新建“{search}”</span></button>}
    {error && <p className="tag-picker-error" role="alert">{error}</p>}
    <footer><button disabled={busy || !tags.length} onClick={() => void update([])}>清空 Tag</button><span role="status">{busy ? '保存中…' : tags.length ? `已选 ${tags.length} 个` : '默认颜色'}</span></footer>
  </section>, document.body);
}
