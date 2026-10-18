import { defineBackground } from 'wxt/utils/define-background';
import { CHANNEL, type ActivePage, type ApiSettings, type AppCommand, type ContentCommand, type Draft, type PageSnapshot, type Reply, type SelectionSnapshot, type UiIntent } from '../src/core/types';
import { mutateState, readState } from '../src/core/repository';
import { applyCommand, bindDraft, captureSnapshot, exportBackup, safeUrl, updateCaptured } from '../src/core/state';
import { uid } from '../src/core/context';

export default defineBackground(() => {
  const notify = () => chrome.runtime.sendMessage({ channel: CHANNEL, changed: true }).catch(() => undefined);
  const inflight = new Set<string>();
  const isDeepseek = (url = '') => { try { return new URL(url).origin === 'https://chat.deepseek.com'; } catch { return false; } };
  const trustedPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  const defaultSettings: ApiSettings = { endpoint: 'https://api.deepseek.com/chat/completions', model: '', apiKey: '' };
  async function targetTab(tabId?: number): Promise<chrome.tabs.Tab> {
    if (tabId !== undefined) return chrome.tabs.get(tabId);
    const current = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (current?.url?.startsWith('http')) { await chrome.storage.session.set({ lastWebTab: current.id }); return current; }
    const stored = await chrome.storage.session.get('lastWebTab');
    if (typeof stored.lastWebTab === 'number') { try { return await chrome.tabs.get(stored.lastWebTab); } catch { /* Closed tab. */ } }
    throw new Error('请先打开要整理的网页，然后点击扩展图标。');
  }
  async function content<T>(tabId: number, command: ContentCommand): Promise<T> {
    let reply: Reply<T>;
    try { reply = await chrome.tabs.sendMessage(tabId, { channel: CHANNEL, command }); }
    catch { throw new Error('尚未连接到 DeepSeek 页面，请刷新该网页后重试。'); }
    if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : '页面没有响应。');
    return reply.data;
  }
  async function active(tabId?: number): Promise<ActivePage> {
    const t = await targetTab(tabId); if (t.id === undefined || !t.url) throw new Error('无法读取当前页面。');
    const page: ActivePage = { tabId: t.id, url: t.url, title: t.title ?? '未命名页面', supported: isDeepseek(t.url) };
    if (page.supported) {
      try { page.snapshot = await content(t.id, { type: 'cw.snapshot' }); } catch { /* A new conversation has no persistent URL yet. */ }
      try { page.selection = await content(t.id, { type: 'cw.selection' }); } catch { /* Display connection guidance in UI. */ }
    }
    return page;
  }
  async function saveDraft(draft: Draft) { await mutateState(s => applyCommand(s, { type: 'draft.save', draft })); notify(); }
  async function fillWaiting(id: string): Promise<void> {
    if (inflight.has(id)) return; inflight.add(id);
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const draft = (await readState()).drafts.find(d => d.id === id);
        if (!draft || draft.status !== 'waiting' || draft.tabId === undefined) return;
        try {
          const tab = await chrome.tabs.get(draft.tabId); if (!isDeepseek(tab.url)) throw new Error('等待 DeepSeek 页面打开。');
          const current = await content<string>(draft.tabId, { type: 'cw.composer' });
          if (current.trim() && current.trim() !== draft.prompt.trim()) { await saveDraft({ ...draft, status: 'failed', error: '目标输入框已有内容；草稿已保留，请在预览中确认后重试。' }); return; }
          if (current.trim() !== draft.prompt.trim()) await content(draft.tabId, { type: 'cw.fill', text: draft.prompt, mode: 'replace' });
          await saveDraft({ ...draft, status: 'filled', error: undefined }); return;
        } catch (error) {
          if (attempt === 29) { await saveDraft({ ...draft, status: 'failed', error: error instanceof Error ? error.message : '填写超时，请登录 DeepSeek 后重试。' }); return; }
          await new Promise(resolve => setTimeout(resolve, 700));
        }
      }
    } finally { inflight.delete(id); }
  }
  const install = async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await mutateState(s => { s.drafts.forEach(d => { if (d.status === 'waiting' || d.status === 'filled') { d.status = 'preview'; delete d.tabId; } }); return s; });
    await chrome.contextMenus.removeAll();
    for (const [id, title] of [['current', '拾序：在当前对话追问'], ['new', '拾序：在新对话追问'], ['snippet', '拾序：加入片段篮'], ['explain', '拾序：解释所选内容'], ['example', '拾序：举例说明'], ['check', '拾序：检查所选内容']]) chrome.contextMenus.create({ id: 'cw-' + id, title: title!, contexts: ['selection'] });
  };
  chrome.runtime.onInstalled.addListener(() => { void install(); });
  chrome.runtime.onStartup.addListener(() => { void install(); });
  chrome.tabs.onActivated.addListener(({ tabId }) => { chrome.tabs.get(tabId).then(t => { if (t.url?.startsWith('http')) return chrome.storage.session.set({ lastWebTab: tabId }); }).then(notify).catch(() => undefined); });
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'complete') void readState().then(s => Promise.all(s.drafts.filter(d => d.tabId === tabId && d.status === 'waiting').map(d => fillWaiting(d.id)))); });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!String(info.menuItemId).startsWith('cw-') || tab?.id === undefined) return;
    const tabId = tab.id; const key = String(info.menuItemId).slice(3);
    // Keep this call synchronous with the user gesture.
    void chrome.sidePanel.open({ tabId }).catch(() => undefined);
    void (async () => {
      let selection: SelectionSnapshot = { text: info.selectionText ?? '', title: tab.title ?? '选中片段', url: info.pageUrl ?? tab.url ?? '' };
      if (isDeepseek(selection.url)) try { const captured = await content<SelectionSnapshot>(tabId, { type: 'cw.selection' }); if (captured.text.trim() === selection.text.trim()) selection = captured; } catch { /* context menu text remains usable */ }
      safeUrl(selection.url);
      const intent: UiIntent = { action: ['snippet', 'explain', 'example', 'check'].includes(key) ? key as UiIntent['action'] : 'followup', destination: key === 'current' && isDeepseek(selection.url) ? 'current' : 'new', selection, tabId, nonce: uid() };
      await chrome.storage.session.set({ intent, lastWebTab: tabId }); notify();
    })().catch(() => undefined);
  });
  async function handle(command: AppCommand): Promise<unknown> {
    switch (command.type) {
      case 'state.get': return readState();
      case 'page.active': return active();
      case 'page.composer': { const tab = await targetTab(command.tabId); return content(tab.id!, { type: 'cw.composer' }); }
      case 'page.locate': { const tab = await targetTab(command.tabId); const located = await content<boolean>(tab.id!, { type: 'cw.locate', turnId: command.turnId }); if (!located) throw new Error('该轮次尚未显示，请在原页面加载历史后重试。'); return true; }
      case 'page.open': return chrome.tabs.create({ url: safeUrl(command.url) });
      case 'conversation.capture': {
        const page = await active(command.tabId);
        if (page.supported && !page.snapshot) throw new Error('请打开已发送消息的 DeepSeek 对话，刷新网页并等待内容加载后再收纳。');
        const snapshot = page.snapshot ?? { site: new URL(page.url).hostname, externalId: page.url, url: page.url, title: page.title, turns: [], complete: false };
        const state = await mutateState(s => captureSnapshot(s, snapshot, command.containerId).state); notify(); return state;
      }
      case 'draft.fill': {
        const draft = (await readState()).drafts.find(d => d.id === command.id); if (!draft) throw new Error('草稿不存在。');
        if (!draft.prompt.trim()) throw new Error('请输入问题或引用上下文。');
        if (draft.destination === 'new') {
          const tab = await chrome.tabs.create({ url: 'about:blank' }); if (tab.id === undefined) throw new Error('无法创建标签页。');
          await saveDraft({ ...draft, status: 'waiting', tabId: tab.id, error: undefined });
          await chrome.tabs.update(tab.id, { url: 'https://chat.deepseek.com/' }); void fillWaiting(draft.id); return { pending: true };
        }
        const tab = await targetTab(command.tabId ?? draft.tabId); const previous = await content<string>(tab.id!, { type: 'cw.composer' });
        if (command.expectedComposer !== undefined && previous !== command.expectedComposer) throw new Error('输入框内容已变化，请重新打开预览后确认。');
        const mode = command.mode ?? 'append'; const prompt = mode === 'append' && previous.trim() ? previous.trimEnd() + '\n\n' + draft.prompt : draft.prompt;
        await content(tab.id!, { type: 'cw.fill', text: draft.prompt, mode }); await saveDraft({ ...draft, prompt, status: 'filled', tabId: tab.id }); return { pending: false };
      }
      case 'settings.get': return (await chrome.storage.local.get('apiSettings')).apiSettings ?? defaultSettings;
      case 'settings.save': {
        const s = command.settings; const u = new URL(s.endpoint); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('接口须使用 HTTPS，本机服务可使用 HTTP。');
        if (u.username || u.password || u.hash || s.apiKey.length > 10000 || s.model.length > 500) throw new Error('API 设置无效。');
        await chrome.storage.local.set({ apiSettings: { endpoint: s.endpoint, model: s.model.trim(), apiKey: s.apiKey.trim() } }); return true;
      }
      case 'backup.export': return exportBackup(await readState());
      case 'intent.get': return (await chrome.storage.session.get('intent')).intent ?? null;
      case 'intent.clear': { const { intent } = await chrome.storage.session.get('intent'); if (intent?.nonce === command.nonce) await chrome.storage.session.remove('intent'); return true; }
      case 'data.clear': await chrome.storage.local.remove('apiSettings'); await chrome.storage.session.remove(['intent', 'lastWebTab']); break;
    }
    const next = await mutateState(s => applyCommand(s, command)); notify(); return next;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL) return false;
    if (message.event && sender.tab?.id !== undefined && isDeepseek(sender.url)) {
      const event = message.event;
      if (event.type === 'cw.updated') {
        const snapshot = event.snapshot as PageSnapshot;
        if (!snapshot || snapshot.site !== 'deepseek' || typeof snapshot.externalId !== 'string' || !snapshot.externalId || !isDeepseek(snapshot.url) || !Array.isArray(snapshot.turns) || snapshot.turns.length > 50000 || snapshot.turns.some(t => typeof t.user !== 'string' || typeof t.assistant !== 'string' || t.user.length + t.assistant.length > 2000000)) return false;
        const tabId = sender.tab.id;
        void mutateState(s => { let next = updateCaptured(s, snapshot); for (const d of next.drafts.filter(d => d.tabId === tabId && d.destination === 'new' && d.status === 'filled')) next = bindDraft(next, d.id, snapshot); return next; }).then(notify).catch(() => undefined);
      }
      return false;
    }
    if (!trustedPage(sender) || !message.command || typeof message.command.type !== 'string') return false;
    handle(message.command).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' })); return true;
  });
});
