import type { OpenMode } from './types';
import { platformConversation } from '../adapters/platforms';

type SplitTab = chrome.tabs.Tab & { splitViewId?: number };
type SplitTabs = typeof chrome.tabs & {
  createSplit?: (tabIds: [number, number]) => Promise<number>;
  create: (properties: chrome.tabs.CreateProperties & { splitWithTabId?: number }) => Promise<SplitTab>;
};
export interface OpenedPage { tab: chrome.tabs.Tab; notice?: string; noticeLevel?: 'info' | 'warning' }

// Serialize opens so rapid double clicks cannot create competing right panes.
let queue: Promise<unknown> = Promise.resolve();
export function openPage(url: string, mode: OpenMode, anchorId?: number, blockedIds: number[] = []): Promise<OpenedPage> {
  const operation = queue.then(async () => {
    const tabs = chrome.tabs as SplitTabs;
    let anchor: SplitTab | undefined;
    if (anchorId !== undefined) try { anchor = await tabs.get(anchorId); } catch {}
    anchor ??= (await tabs.query({ active: true, currentWindow: true }))[0] as SplitTab | undefined;
    if (mode === 'tab' || !anchor?.id) return { tab: await tabs.create({ url, windowId: anchor?.windowId }) };
    const peers = (await tabs.query({ windowId: anchor.windowId }) as SplitTab[])
      .filter(t => anchor.splitViewId !== undefined && anchor.splitViewId !== -1 && t.splitViewId === anchor.splitViewId)
      .sort((a, b) => a.index - b.index);
    if (peers.length === 2) {
      // Chrome's adjacent tab order is the left/right order. Reuse the right tab.
      const right = peers[1]!;
      if (url !== 'about:blank') {
        const identity = platformConversation(url);
        const matching = peers.find(t => t.url === url || identity && JSON.stringify(platformConversation(t.url ?? '')) === JSON.stringify(identity));
        if (matching?.id !== undefined) { const tab = await tabs.update(matching.id, { active: true }); return { tab: tab! }; }
      }
      if (blockedIds.includes(right.id!)) throw new Error('右侧分栏正在发送，请等待完成后再打开节点。');
      const tab = await tabs.update(right.id!, { url, active: true });
      if (!tab) throw new Error('右侧分栏已关闭，请重试。');
      return { tab };
    }
    if (typeof tabs.createSplit !== 'function') return { tab: await tabs.create({ url, windowId: anchor.windowId }), notice: '此 Chrome 版本尚不支持扩展创建原生分栏，已在新标签页打开。' };
    const tab = await tabs.create({ url, windowId: anchor.windowId, index: anchor.index + 1, splitWithTabId: anchor.id });
    return { tab };
  });
  queue = operation.catch(() => undefined);
  return operation;
}
