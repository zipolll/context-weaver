import type { SiteAdapter } from './types';
import type { SendResult } from '../core/types';
import { normalizeText } from './dom';
export function createSendController(adapter: SiteAdapter, url: () => string = () => location.href, pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve,ms)), now = Date.now) {
  const requests = new Map<string, Promise<SendResult>>(); let active = false;
  return function send(requestId: string, text: string, expectedComposer: string): Promise<SendResult> {
    const existing = requests.get(requestId); if (existing) return existing;
    if (active) return Promise.reject(new Error('另一条消息正在发送，请稍候。'));
    active = true;
    const promise = (async (): Promise<SendResult> => {
      let clicked = false;
      try {
        const initialUrl = url();
        if (!text.trim()) throw new Error('请输入要发送的内容。');
        if (adapter.readComposer() !== expectedComposer) throw new Error('输入内容已变化，请重新确认。');
        if (adapter.composerState() === 'generating') throw new Error('当前回答尚未结束，请稍后发送。');
        adapter.fillComposer(text,'replace');
        const readyUntil = now() + 8000;
        while (adapter.composerState() !== 'ready' && now() < readyUntil) {
          if (url() !== initialUrl || normalizeText(adapter.readComposer()) !== normalizeText(text)) throw new Error('页面或输入内容已变化，请重新确认。');
          await pause(200);
        }
        if (url() !== initialUrl || normalizeText(adapter.readComposer()) !== normalizeText(text)) throw new Error('页面或输入内容已变化，请重新确认。');
        if (adapter.composerState() !== 'ready') throw new Error('发送按钮不可用，请检查登录状态或等待回答结束。');
        let previousIds = new Set<string>();
        try { previousIds = new Set(adapter.readSnapshot().turns.map(t=>t.id)); } catch {}
        // Once we invoke the submit method, any uncertainty must never trigger an automatic retry.
        clicked = true; adapter.submitComposer(text);
        const until = now() + 15000;
        while (now() < until) {
          try { const snapshot = adapter.readSnapshot(); const turn = snapshot.turns.find(t => !previousIds.has(t.id) && normalizeText(t.user) === normalizeText(text)); if (turn) return {status:'sent',snapshot,turnId:turn.id}; } catch {}
          await pause(250);
        }
        return {status:'uncertain'};
      } catch (error) { if (clicked) return {status:'uncertain'}; throw error; }
      finally { active = false; }
    })();
    requests.set(requestId,promise);
    // Explicit failures before clicking can be retried by a new user confirmation.
    void promise.catch(()=>requests.delete(requestId));
    return promise;
  };
}
