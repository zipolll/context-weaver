import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, GitBranch, Inbox, Info, Maximize2, MoreHorizontal, Plus, Settings as SettingsIcon, X } from 'lucide-react';
import { CHANNEL, type Action, type ActivePage, type AppCommand, type AppState, type Conversation, type Draft, type SourceSnapshot, type UiIntent } from '../core/types';
import { request } from '../core/client';
import { createInitialState } from '../core/state';
import { snapshotConversation, uid } from '../core/context';
import { platformFor, platformName, type PlatformId } from '../adapters/platforms';
import { questionTitle } from '../core/questions';
import { Library } from './Library';
import { Settings } from './Settings';
import { Preview } from './Preview';
import { Graph } from './Graph';
import { withWorkspace } from '../core/workspace';
import { selectionSource } from '../core/sources';

export function App({ workspace = false }: { workspace?: boolean }) {
  const [state, setState] = useState<AppState>(() => withWorkspace(createInitialState()));
  const [page, setPage] = useState<ActivePage | null>(null);
  const [view, setView] = useState('graph');
  const [lastPlatform, setLastPlatform] = useState<PlatformId>('deepseek');
  const [error, setError] = useState('');
  const [message, setMessage] = useState<{ text: string; level: 'success' | 'info' | 'warning' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Draft | null>(null);
  const [detail, setDetail] = useState<Conversation | null>(null);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => { const sequence = ++refreshSequence.current; const next = await request<AppState>({ type: 'state.get' }); if (sequence === refreshSequence.current) setState(withWorkspace(next)); }, []);
  const refreshPage = useCallback(async () => { try { setPage(await request<ActivePage>({ type: 'page.active' })); } catch { setPage(null); } }, []);
  const report = (text: string) => setError(text);
  const run = async (command: AppCommand): Promise<unknown> => {
    setError('');
    if (command.type === 'page.open' || command.type === 'page.locate') setMessage(null);
    try {
      const data = await request(command);
      if ((data as { notice?: string })?.notice) { const notice = data as { notice: string; noticeLevel?: 'info' | 'warning' }; setMessage({ text: notice.notice, level: notice.noticeLevel ?? 'info' }); }
      await refresh();
      if (command.type === 'conversation.capture') { setMessage({ text: '已收纳，后续访问时自动更新。', level: 'success' }); await refreshPage(); }
      return data;
    } catch (caught) { setError((caught as Error).message); throw caught; }
  };
  const safeRun = async (command: AppCommand) => { try { return await run(command); } catch { return undefined; } };
  function openPreview(sources: SourceSnapshot[], destination: Draft['destination'] = 'new', action: Action = 'followup') {
    setPreview({ id: uid(), graphId: state.activeGraphId, openMode: state.openMode, sources, question: '', action, templateId: state.templates.find(item => item.action === action)?.id ?? state.templates[0]!.id, prompt: '', destination, targetSite: page?.site ?? lastPlatform, tabId: page?.supported ? page.tabId : undefined, status: 'preview', createdAt: Date.now() });
  }
  const processIntent = useCallback(async () => {
    const intent = await request<UiIntent | null>({ type: 'intent.claim' });
    if (!intent) return;
    // Stage actions are stored directly by the service worker. This also keeps
    // a stale session intent from ever being interpreted as a send action.
    if (intent.action === 'stage' || !['followup', 'explain', 'example', 'check'].includes(intent.action)) return;
    const current = await request<AppState>({ type: 'state.get' });
    const source = selectionSource(current, intent.selection);
    setPreview({ id: uid(), graphId: current.activeGraphId, openMode: current.openMode, sources: [source], question: '', action: intent.action, templateId: current.templates.find(item => item.action === intent.action)?.id ?? current.templates[0]!.id, prompt: '', destination: intent.destination, targetSite: platformFor(intent.selection.url)?.id ?? await request<PlatformId>({ type: 'platform.last' }), tabId: platformFor(intent.selection.url) ? intent.tabId : undefined, status: 'preview', createdAt: Date.now() });
    await refresh();
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const update = async () => { try { await Promise.all([refresh(), refreshPage(), request<PlatformId>({ type: 'platform.last' }).then(setLastPlatform)]); if (active) await processIntent(); } catch (caught) { if (active) setError((caught as Error).message); } finally { if (active) setLoading(false); } };
    void update();
    const listener = (event: unknown) => { if ((event as { channel?: string; changed?: boolean })?.channel === CHANNEL && (event as { changed?: boolean }).changed) void update(); };
    chrome.runtime.onMessage.addListener(listener); return () => { active = false; chrome.runtime.onMessage.removeListener(listener); };
  }, [refresh, refreshPage, processIntent]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(null), message.level === 'warning' ? 8000 : 4000); return () => clearTimeout(timer); }, [message]);
  const toggle = (id: string) => setSelected(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const branch = (ids: string[]) => openPreview(ids.map(id => state.conversations.find(item => item.id === id)).filter((item): item is Conversation => !!item).map(item => snapshotConversation(item)));
  const stageSelection = () => {
    const selection = page?.selection; if (!selection) return;
    return safeRun({ type: 'stage.save', item: { id: uid(), source: selectionSource(state, selection), selected: true, createdAt: Date.now() } });
  };
  const shown = detail ? state.conversations.find(item => item.id === detail.id) ?? detail : null;
  const back = () => { setView('graph'); setDetail(null); };
  return <div className={'app ' + (workspace ? 'workspace ' : '') + (view === 'graph' ? 'graph-app' : '')}>
    <header className="app-header"><button className="brand-home" onClick={back}><span className="brand-mark"><GitBranch size={19} /></span><strong>UniFAI</strong></button><div className="row">{!workspace && <button className="icon" aria-label="展开工作区" title="展开工作区" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') })}><Maximize2 size={17} /></button>}<details className="more-menu"><summary aria-label="更多" title="更多"><MoreHorizontal size={20} /></summary><div className="menu-popover"><button onClick={event => { setView('library'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>对话库</button></div></details><button className="icon" aria-label="设置" onClick={() => setView('settings')}><SettingsIcon size={18} /></button></div></header>
    {error && <div className="banner error" role="alert"><span>{error}</span><button className="icon small" aria-label="关闭错误" onClick={() => setError('')}><X size={15} /></button></div>}{message && <div className={'banner ' + message.level} role={message.level === 'warning' ? 'alert' : 'status'}>{message.level === 'success' ? <Check size={15} /> : message.level === 'warning' ? <AlertTriangle size={15} /> : <Info size={15} />}<span>{message.text}</span><button className="icon small" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={15} /></button></div>}
    {view === 'library' && <div className="library-toolbar"><span className="muted">{page?.site ? platformName(page.site) : '本地对话库'}</span><button className="capture-button" disabled={!page} onClick={() => void safeRun({ type: 'conversation.capture', tabId: page?.tabId })}><Plus size={14} />收纳当前对话</button>{page?.selection?.text && <button className="capture-button" onClick={() => void stageSelection()}><Inbox size={14} />暂存选中内容</button>}</div>}
    {view !== 'graph' && view !== 'settings' && <button className="back-link text-button" onClick={back}><ArrowLeft size={15} />返回知识图</button>}
    <main>{loading ? <div className="empty-state">正在加载…</div> : view === 'settings' ? <Settings state={state} run={safeRun} close={back} report={report} /> : view === 'library' ? <Library state={state} run={safeRun} selected={selected} toggle={toggle} onBranch={branch} onOpen={item => { setDetail(item); setView('detail'); }} /> : view === 'graph' ? <Graph state={state} page={page} run={safeRun} onBranch={sources => openPreview(sources)} /> : view === 'detail' && shown ? <section className="navigation"><div className="section-heading"><h2>{shown.sourceTitle || shown.title}</h2><button onClick={() => void safeRun({ type: 'page.open', url: shown.url })}>原页面</button></div><p className="muted">已保存 {shown.turns.length} 个问题</p><div className="simple-questions">{shown.turns.map(turn => <div key={turn.id}><button onClick={() => { if (page?.url !== shown.url) { report('请先打开原页面，再点击问题定位。'); return; } void safeRun({ type: 'page.locate', tabId: page.tabId, turnId: turn.id }); }}>{questionTitle(turn.user, turn.question)}</button><details className="more-menu"><summary aria-label="问题操作"><MoreHorizontal size={17} /></summary><div className="menu-popover"><button onClick={() => openPreview([snapshotConversation(shown, turn.id)])}>从这里分支</button></div></details></div>)}</div><button onClick={() => branch([shown.id])}>继承全部上下文</button></section> : null}</main>
    {preview && <Preview key={preview.id} initial={preview} state={state} currentPage={page} close={() => setPreview(null)} report={report} refresh={refresh} />}
  </div>;
}
