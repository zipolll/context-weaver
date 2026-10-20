import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInitialState } from '../../src/core/state';
import { newGraph } from '../../src/core/workspace';
import type { AppCommand, AppState, Conversation } from '../../src/core/types';

// Exercise the real service worker, IndexedDB and content script. AI pages are local fixtures.
test('reopening keeps one conversation and locates questions despite changing DOM IDs', async () => {
  const temporaryRoot = path.resolve(os.tmpdir()), profile = fs.mkdtempSync(path.join(temporaryRoot, 'unifai-reopen-'));
  const extensionPath = path.resolve('.output/chrome-mv3');
  let context: BrowserContext | undefined;
  try {
    const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (fs.existsSync(localChrome) ? localChrome : undefined), ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'], viewport: { width: 420, height: 860 } });
    const protocol = await context.browser()!.newBrowserCDPSession();
    await protocol.send('Extensions.loadUnpacked', { path: extensionPath });
    const url = 'https://chat.deepseek.com/a/chat/s/source';
    let render = 0;
    await context.route('https://chat.deepseek.com/**', route => {
      if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
      const sequence = ++render;
      const html = fs.readFileSync(path.resolve('tests/fixtures/deepseek.html'), 'utf8')
        .replaceAll('data-virtual-list-item-key="u1"', `data-virtual-list-item-key="u1-open-${sequence}"`)
        .replaceAll('data-virtual-list-item-key="u2"', `data-virtual-list-item-key="u2-open-${sequence}"`)
        .replaceAll('class="ds-assistant-message-main-content"', 'class="ds-assistant-message-main-content" hidden')
        .replace('</body>', '<script>setTimeout(()=>document.querySelectorAll(".ds-assistant-message-main-content[hidden]").forEach(node=>node.removeAttribute("hidden")),1000)</script></body>');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const site = await context.newPage(); await site.goto(url);
    const tabId = await worker.evaluate(async pageUrl => (await chrome.tabs.query({ url: pageUrl }))[0]!.id!, url);
    await worker.evaluate(async id => chrome.storage.session.set({ lastWebTab: id }), tabId);
    const ui = await context.newPage(); await ui.goto('chrome-extension://' + new URL(worker.url()).host + '/sidepanel.html');
    async function command(c: AppCommand) {
      const reply = await ui.evaluate(async cmd => chrome.runtime.sendMessage({ channel: 'context-weaver', command: cmd }), c);
      expect(reply.ok, reply.error).toBe(true); return reply.data;
    }
    // Start with a saved capture, then reopen under different rendered message IDs.
    const original: Conversation = { id: 'original', site: 'chat.deepseek.com', externalId: url, url, title: '测试在线交互', customTitle: true, containerId: null, tags: ['保留标签'], starred: false, archived: false, complete: false, turns: [
      { id: 'source:message:saved-1', user: '什么是特征向量？', assistant: '在线性变换后方向不变的向量。\nAv = λv', index: 0, fingerprint: 'one' },
      { id: 'source:message:saved-2', user: '请举例。', assistant: '考虑对角矩阵。', index: 1, fingerprint: 'two' }
    ], createdAt: 1, updatedAt: 1 };
    const graph = { ...newGraph('重复打开回归'), id: 'reopen-graph', conversationIds: ['original', 'duplicate', 'original'] };
    const backup: AppState = { ...createInitialState(), conversations: [original, { ...original, id: 'duplicate', site: 'deepseek', externalId: 'source', createdAt: 2 }], graphs: [graph], activeGraphId: graph.id, openMode: 'tab' };
    await command({ type: 'backup.import', data: backup });
    await command({ type: 'graph.activate', id: graph.id }); await command({ type: 'openMode.save', mode: 'tab' });
    const node = ui.locator('.conversation-node'); await expect(node).toHaveCount(1);
    for (let i = 0; i < 3; i++) {
      const opened = context.waitForEvent('page'); await node.dblclick(); const tab = await opened;
      // Chrome-created tabs can begin their first request before Playwright attaches.
      // DNS is disabled above; explicitly load the intercepted local fixture once attached.
      await tab.goto(url);
      await expect.poll(async () => (await command({ type: 'state.get' })).conversations[0]?.sourceTitle).toBe('线性代数');
      const rawId = 'source:message:' + await tab.locator('[data-virtual-list-item-key]').first().getAttribute('data-virtual-list-item-key');
      await expect.poll(async () => (await command({ type: 'state.get' })).conversations[0]?.turns[0]?.aliases?.includes(rawId)).toBe(true);
      const state: AppState = await command({ type: 'state.get' });
      expect(state.conversations).toHaveLength(1);
      expect(state.conversations[0]).toMatchObject({ id: 'original', site: 'deepseek', externalId: 'source', tags: ['保留标签'], customTitle: true });
      expect(state.graphs!.find(g => g.id === graph.id)!.conversationIds).toEqual(['original']);
      expect(state.conversations[0]!.turns).toHaveLength(2);
      await expect(node).toHaveCount(1);
    }
    await node.click(); await expect(ui.locator('.question-node')).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      const opened = context.waitForEvent('page'); await ui.locator('.question-node').nth(index).dblclick(); const tab = await opened; await tab.goto(url);
      const question = tab.locator('._9663006 .fbb737a4').nth(index);
      await expect(question).toHaveCSS('outline-style', 'solid');
      if (index === 1) await tab.screenshot({ path: 'artifacts/unifai-v037-question-jump.png' });
      const state: AppState = await command({ type: 'state.get' });
      expect(state.conversations).toHaveLength(1); expect(state.conversations[0]!.turns).toHaveLength(2);
    }
    await ui.screenshot({ path: 'artifacts/unifai-v037-reopen-extension.png' });
  } finally {
    await context?.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('unifai-reopen-')) throw new Error('Unexpected temporary profile path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
