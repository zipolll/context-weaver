import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, Minimize2, Trash2, X } from 'lucide-react';
import type { Action, ApiSettings, AppState, Draft, SourceSnapshot } from '../core/types';
import { ACTION_LABELS, renderPrompt } from '../core/context';
import { request } from '../core/client';
import { compressContext } from '../core/compression';
import { ensureApiPermission } from './Settings';
export function Preview({ initial, state, close, report: reportParent, refresh }: { initial: Draft; state: AppState; close: () => void; report: (text: string) => void; refresh: () => Promise<void> }) {
  const [localError, setLocalError] = useState('');
  const report = (text: string) => { setLocalError(text); reportParent(text); };
  const [draft, setDraft] = useState(initial); const [sources, setSources] = useState<SourceSnapshot[]>(structuredClone(initial.editedSources ?? initial.sources));
  const [prompt, setPrompt] = useState(initial.prompt); const [previous, setPrevious] = useState(''); const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [busy, setBusy] = useState(false), [compressing, setCompressing] = useState(false), [summary, setSummary] = useState(''), [compressionOpen, setCompressionOpen] = useState(false);
  const [settings, setSettings] = useState<ApiSettings | null>(null); const [status, setStatus] = useState(''); const abort = useRef<AbortController | null>(null); const lastComposed = useRef<string | null>(null);
  const template = state.templates.find(t => t.id === draft.templateId) ?? state.templates[0]!;
  const composed = renderPrompt(template, draft.question, sources, draft.action);
  useEffect(() => { if (lastComposed.current === null) { lastComposed.current = composed; if (!initial.prompt) setPrompt(composed); } else if (lastComposed.current !== composed) { lastComposed.current = composed; setPrompt(composed); setSummary(''); } }, [composed]);
  useEffect(() => { request<ApiSettings>({ type: 'settings.get' }).then(setSettings).catch(e => report(e.message)); return () => abort.current?.abort(); }, []);
  useEffect(() => { if (draft.destination === 'current') request<string>({ type: 'page.composer', tabId: draft.tabId }).then(setPrevious).catch(e => report(e.message)); else setPrevious(''); }, [draft.destination, draft.tabId]);
  const changeSource = (index: number, text: string) => setSources(sources.map((s, i) => i === index ? { ...s, text } : s));
  function move(index: number, direction: number) { const next = [...sources]; const item = next.splice(index, 1)[0]!; next.splice(index + direction, 0, item); setSources(next); }
  async function save(fill: boolean) {
    setBusy(true); setStatus(''); setLocalError('');
    try {
      if (fill && draft.destination === 'current') { const current = await request<string>({ type: 'page.composer', tabId: draft.tabId }); if (current !== previous) { setPrevious(current); throw new Error('原页面输入已变化，合并预览已更新，请再次确认。'); } }
      
      const next: Draft = { ...draft, prompt, sources: sources.map(s => initial.sources.find(original => original.id === s.id) ?? s), editedSources: structuredClone(sources), status: 'preview', error: undefined };
      await request({ type: 'draft.save', draft: next });
      if (fill) { const result = await request<{ pending: boolean }>({ type: 'draft.fill', id: next.id, mode, tabId: next.tabId, expectedComposer: previous }); setStatus(result.pending ? '已打开新对话，正在等待输入框。草稿会自动恢复；请在网页中确认并发送。' : '已填入输入框，请回到网页确认并发送。'); }
      else setStatus('草稿已保存。');
      await refresh();
    } catch (e) { report((e as Error).message); } finally { setBusy(false); }
  }
  async function compress() {
    if (!settings) return;
    setCompressing(true); abort.current = new AbortController();
    try { await ensureApiPermission(settings.endpoint); const text = sources.map((s, i) => '[' + (i + 1) + '] ' + s.title + '\n' + s.text + '\n来源：' + s.url).join('\n\n'); setSummary(await compressContext(settings, text, abort.current.signal)); } catch (e) { report((e as Error).message); } finally { setCompressing(false); }
  }
  const mergedPrompt = previous.trim() && mode === 'append' && draft.destination === 'current' ? previous.trimEnd() + '\n\n' + prompt : prompt;
  return <div className="modal-backdrop"><section className="preview" role="dialog" aria-modal="true" aria-labelledby="preview-title"><header className="modal-header"><div><p className="eyebrow">上下文工作台</p><h2 id="preview-title">把线索带入下一段对话</h2></div><button className="icon" aria-label="关闭预览" onClick={close}><X/></button></header>
    <div className="preview-content">{localError && <div className="banner error" role="alert">{localError}</div>}<div className="two-columns"><label>操作<select value={draft.action} onChange={e => { const action = e.target.value as Action; setDraft({ ...draft, action, templateId: state.templates.find(t => t.action === action)?.id ?? draft.templateId }); }}>{Object.entries(ACTION_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>目标<select value={draft.destination} onChange={e => setDraft({ ...draft, destination: e.target.value as Draft['destination'] })}><option value="new">DeepSeek 新对话</option>{draft.tabId !== undefined && <option value="current">当前 DeepSeek 对话</option>}</select></label></div>
    <label>你的问题<textarea autoFocus rows={3} value={draft.question} onChange={e => setDraft({ ...draft, question: e.target.value })} placeholder="基于这些上下文，你想继续了解什么？"/></label>
    <div className="section-heading"><h3>引用上下文 <span className="muted">{sources.length} 个来源</span></h3><button className="text-button" disabled={!sources.length} onClick={() => setCompressionOpen(!compressionOpen)}><Minimize2 size={14}/>压缩</button></div>
    {!sources.length && <p className="muted">当前没有引用。你也可以直接编辑问题与最终提示词。</p>}
    {sources.map((s, i) => { const original = initial.sources.find(x => x.id === s.id); const available = original?.turns ?? []; return <details className="source-block" key={s.id} open={sources.length === 1 || undefined}><summary><span className="source-number">{i + 1}</span><span>{s.title}</span><span className="muted">{s.text.length.toLocaleString()} 字</span></summary><div className="source-body"><p className="source-url">{s.url}</p><div className="row"><button className="icon small" disabled={i === 0} aria-label="来源上移" onClick={() => move(i, -1)}><ArrowUp size={14}/></button><button className="icon small" disabled={i === sources.length - 1} aria-label="来源下移" onClick={() => move(i, 1)}><ArrowDown size={14}/></button><button className="text-button danger" onClick={() => setSources(sources.filter(x => x.id !== s.id))}><Trash2 size={13}/>移除引用</button></div>{available.length > 0 && <details><summary>按轮次筛选</summary>{available.map(t => <label className="checkbox-label" key={t.id}><input type="checkbox" checked={s.turnIds.includes(t.id)} onChange={e => { const box = e.currentTarget.closest('details'); const selectedIds = [...(box?.querySelectorAll<HTMLInputElement>('input:checked') ?? [])].map(el => el.value); setSources(sources.map((item, j) => j === i ? { ...item, turnIds: selectedIds, text: available.filter(t => selectedIds.includes(t.id)).map(t => '用户：' + t.user + '\n助手：' + t.assistant).join('\n\n') } : item)); }} value={t.id}/><span>{t.index + 1}. {t.user.slice(0, 80)}</span></label>)}</details>}<textarea aria-label={'编辑引用 ' + s.title} rows={6} value={s.text} onChange={e => changeSource(i, e.target.value)}/><p className="footnote">这里的修改只用于本次提示词，原始对话和来源快照仍保留。</p></div></details>; })}
    {compressionOpen && <section className="compression-box"><h3>确认提交的内容</h3><p>将上述 {sources.length} 个来源的引用文本与链接提交至 <strong>{settings ? (() => { try { return new URL(settings.endpoint).host; } catch { return '未配置服务'; } })() : '未配置服务'}</strong>，用于生成摘要。</p><p className="footnote">未配置 API 时请先打开设置填写接口、模型与 Key。模型可能遗漏信息，请检查摘要。</p><div className="row"><button disabled={compressing || !sources.length} onClick={() => void compress()}>{compressing ? '压缩中…' : '确认并压缩'}</button>{compressing && <button onClick={() => abort.current?.abort()}>取消请求</button>}</div>{summary && <><label>压缩结果<textarea rows={7} value={summary} onChange={e => setSummary(e.target.value)}/></label><div className="row"><button onClick={() => { const compressed = { ...sources[0]!, title: '多来源摘要', text: summary }; setPrompt(renderPrompt(template, draft.question, [compressed], draft.action) + '\n\n原始来源：\n' + sources.map((s, i) => '[' + (i + 1) + '] ' + s.title + ' ' + s.url).join('\n')); setStatus('摘要已应用到最终提示词，原始引用仍保留。'); }}>采用摘要</button><button onClick={() => { setPrompt(composed); setSummary(''); }}>撤销压缩</button></div></>}</section>}
    <label>最终提示词 <span className="muted">可直接编辑 · {prompt.length.toLocaleString()} 字</span><textarea className="prompt-editor" rows={9} value={prompt} onChange={e => setPrompt(e.target.value)}/></label>
    {draft.destination === 'current' && previous.trim() && <div className="notice"><strong>输入框已有内容</strong><label className="checkbox-label"><input type="radio" checked={mode === 'append'} onChange={() => setMode('append')}/>保留原内容并追加</label><label className="checkbox-label"><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')}/>确认替换原内容</label><details><summary>查看实际填写内容</summary><pre>{mergedPrompt}</pre></details></div>}
    {status && <div className="success" role="status"><Check size={16}/>{status}</div>}</div>
    <footer className="preview-footer"><button className="icon" aria-label="复制最终提示词" onClick={() => void navigator.clipboard.writeText(mergedPrompt).then(() => setStatus('提示词已复制。')).catch(() => report('复制失败，请手动选择提示词复制。'))}><Copy size={17}/></button><button disabled={busy} onClick={() => void save(false)}>保存草稿</button><button className="primary" disabled={busy || !prompt.trim()} onClick={() => void save(true)}>{busy ? '处理中…' : '确认并填入输入框'}</button><span>仅填写，由你发送</span></footer>
  </section></div>;
}
