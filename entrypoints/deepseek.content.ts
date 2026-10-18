import { defineContentScript } from 'wxt/utils/define-content-script';
import { DeepSeekAdapter } from '../src/adapters/deepseek';
import { CHANNEL, type ContentCommand, type ContentEvent, type Reply, type SelectionSnapshot } from '../src/core/types';

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const adapter = new DeepSeekAdapter();
    let lastSelection: SelectionSnapshot | undefined;
    let lastSnapshot = '';
    let lastUrl = location.href;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const emit = (event: ContentEvent) => { chrome.runtime.sendMessage({ channel: CHANNEL, event }).catch(() => { /* Extension may reload while the page remains open. */ }); };
    const publish = () => {
      timer = undefined;
      if (disposed) return;
      try {
        const snapshot = adapter.readSnapshot();
        const key = JSON.stringify(snapshot);
        if (key !== lastSnapshot) { lastSnapshot = key; emit({ type: 'cw.updated', snapshot }); }
      } catch { /* Explicit snapshot requests return a useful UI error. */ }
    };
    const schedule = () => { if (!timer && !disposed) timer = setTimeout(publish, 650); };
    const selectionChanged = () => {
      const selection = adapter.readSelection();
      if (!selection.text) return;
      lastSelection = selection;
      emit({ type: 'cw.selection.changed', selection });
    };
    const listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply: Reply) => void) => {
      if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
      const envelope = message as { channel?: string; command?: ContentCommand };
      if (envelope.channel !== CHANNEL || !envelope.command) return false;
      try {
        const command = envelope.command;
        let data: unknown;
        switch (command.type) {
          case 'cw.snapshot': data = adapter.readSnapshot(); break;
          case 'cw.composer': data = adapter.readComposer(); break;
          case 'cw.fill':
            if (typeof command.text !== 'string' || !['append', 'replace'].includes(command.mode)) throw new Error('无效的输入请求。');
            adapter.fillComposer(command.text, command.mode); data = true; break;
          case 'cw.locate': data = adapter.locateTurn(command.turnId); break;
          case 'cw.selection': { const selected = adapter.readSelection(); data = selected.text ? selected : lastSelection?.url === location.href ? lastSelection : selected; break; }
          default: return false;
        }
        sendResponse({ ok: true, data });
      } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : '页面操作失败。' }); }
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    document.addEventListener('mouseup', selectionChanged);
    document.addEventListener('contextmenu', selectionChanged);
    document.addEventListener('keyup', selectionChanged);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-message-id', 'aria-hidden', 'hidden'] });
    const routeTimer = setInterval(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; lastSnapshot = ''; lastSelection = undefined; schedule(); }
    }, 750);
    window.addEventListener('popstate', schedule);
    schedule();
    ctx.onInvalidated(() => {
      disposed = true; if (timer) clearTimeout(timer); clearInterval(routeTimer); observer.disconnect();
      chrome.runtime.onMessage.removeListener(listener);
      document.removeEventListener('mouseup', selectionChanged); document.removeEventListener('contextmenu', selectionChanged); document.removeEventListener('keyup', selectionChanged); window.removeEventListener('popstate', schedule);
    });
  },
});
