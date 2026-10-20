import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppCommand, AppState, Draft, SourceSnapshot } from '../../src/core/types';

// The installed extension runs normally; AI pages and sends stay inside local fixtures.
test('selection handoff, multiple staged parents, real sends and Tag backup roundtrip', async () => {
  const temporaryRoot = path.resolve(os.tmpdir()), profile = fs.mkdtempSync(path.join(temporaryRoot, 'unifai-provenance-'));
  let context: BrowserContext | undefined;
  try {
    const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (fs.existsSync(localChrome) ? localChrome : undefined), ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'], viewport: { width: 1180, height: 860 } });
    const protocol = await context.browser()!.newBrowserCDPSession(); await protocol.send('Extensions.loadUnpacked', { path: path.resolve('.output/chrome-mv3') });
    const fixture = fs.readFileSync(path.resolve('tests/fixtures/deepseek.html'), 'utf8'); let serial = 0;
    await context.route('https://chat.deepseek.com/**', route => {
      if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
      const fresh = new URL(route.request().url()).pathname === '/', child = 'derived-' + ++serial;
      const html = fresh ? '<!doctype html><html><head><meta charset="utf-8"><title>后续追问</title></head><body><main></main><form><textarea id="chat-input"></textarea><button data-testid="send-button" type="submit">发送</button></form></body></html>' : fixture;
      const script = `<script>window.submitCount=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submitCount++;const input=document.querySelector('textarea'),text=input.value;if(location.pathname==='/')history.pushState({},'','/a/chat/s/${child}');const article=document.createElement('article');article.setAttribute('data-virtual-list-item-key','sent-'+window.submitCount);article.innerHTML='<div class="_9663006"><div class="fbb737a4"></div></div>';article.querySelector('.fbb737a4').textContent=text;document.querySelector('main').append(article);input.value='';});</script>`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html.replace('</body>', script + '</body>') });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const site = await context.newPage(), sourceUrl = 'https://chat.deepseek.com/a/chat/source/?from=context-menu#question'; await site.goto(sourceUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, sourceUrl);
    await worker.evaluate(async id => chrome.storage.session.set({ lastWebTab: id }), tabId);
    const ui = await context.newPage(); await ui.goto('chrome-extension://' + new URL(worker.url()).host + '/sidepanel.html');
    async function command<T = AppState>(c: AppCommand): Promise<T> {
      const reply = await ui.evaluate(async cmd => chrome.runtime.sendMessage({ channel: 'context-weaver', command: cmd }), c);
      expect(reply.ok, reply.error).toBe(true); return reply.data;
    }
    async function expectArrows(count: number) {
      await expect(ui.locator('.provenance-arrow')).toHaveCount(count);
    }
    expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe(JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version);
    let state = await command({ type: 'conversation.capture', tabId }); const sourceId = state.conversations[0]!.id, graphId = state.activeGraphId!;
    await expect(ui.locator('.conversation-node')).toHaveCount(1);
    const rail = site.locator('#context-weaver-question-rail'); await expect(rail.locator('nav button')).toHaveCount(2);
    await rail.locator('nav button').last().click(); await expect(site.locator('[data-virtual-list-item-key="u2"] .fbb737a4')).toHaveCSS('outline-style', 'solid');
    await site.locator('[data-virtual-list-item-key="u1"] .fbb737a4').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selected = window.getSelection()!; selected.removeAllRanges(); selected.addRange(range); });
    const selection = await worker.evaluate(async id => (await chrome.tabs.sendMessage(id, { channel: 'context-weaver', command: { type: 'cw.selection' } })).data, tabId);
    expect(selection.text).toBe('什么是特征向量？'); expect(selection.url).toBe(sourceUrl);
    // Deliver the same stored intent that Chrome's context-menu handler creates.
    async function selectedFollowup(nonce: string) {
      await worker.evaluate(async data => { await chrome.storage.session.set({ intent: { action: 'followup', destination: 'new', ...data } }); await chrome.runtime.sendMessage({ channel: 'context-weaver', changed: true }).catch(() => undefined); }, { selection, tabId, nonce });
      await expect(ui.getByRole('dialog', { name: '继续追问', exact: true })).toBeVisible();
    }
    await selectedFollowup('cancel-selection'); await ui.getByLabel('关闭追问').click();
    expect((await command({ type: 'state.get' })).relations).toHaveLength(0);
    await selectedFollowup('send-selection'); await ui.getByLabel('你的问题', { exact: true }).fill('为什么方向不变？');
    async function sendPreview(): Promise<{ target: Page; draft: Draft; state: AppState }> {
      const opened = context!.waitForEvent('page'); await ui.getByRole('button', { name: '发送', exact: true }).click(); const target = await opened;
      // A Chrome-created tab can start its first request before Playwright attaches.
      try { await target.locator('#chat-input').waitFor({ state: 'visible', timeout: 1500 }); } catch { await target.goto('https://chat.deepseek.com/'); }
      await expect.poll(async () => (await command({ type: 'state.get' })).drafts.every(draft => draft.status === 'bound')).toBe(true);
      const next = await command({ type: 'state.get' }), latest = next.drafts[next.drafts.length - 1]!;
      expect(latest.status).toBe('bound'); expect(await target.evaluate(() => (window as any).submitCount)).toBe(1);
      await ui.getByLabel('关闭追问').click(); return { target, draft: latest, state: next };
    }
    const first = await sendPreview();
    expect(first.draft.sources[0]!.conversationId).toBe(sourceId); expect(first.state.relations).toHaveLength(1);
    await expect(ui.locator('.conversation-node')).toHaveCount(2); await expectArrows(1);
    const secondSite = await context.newPage(); await secondSite.goto('https://chat.deepseek.com/a/chat/s/source-two?from=stage');
    const secondTab = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('/source-two'))!.id!);
    state = await command({ type: 'conversation.capture', tabId: secondTab });
    const secondId = state.conversations.find(c => c.externalId === 'source-two')!.id;
    const frozen = (id: string, url: string, text: string): SourceSnapshot => ({ id, conversationId: null, title: text, url, turnIds: [], text, capturedAt: 1 });
    const staged = [frozen('one', sourceUrl, '第一段引用'), frozen('two', sourceUrl, '第二段引用'), frozen('three', secondSite.url(), '另一段对话'), frozen('excluded', first.target.url(), '未勾选的引用')];
    for (let i = 0; i < staged.length; i++) await command({ type: 'stage.save', item: { id: staged[i]!.id, source: staged[i]!, selected: i !== 3, createdAt: 1 } });
    await ui.locator('.stage-button').click(); await ui.getByRole('button', { name: '用所选内容新建对话' }).click();
    await expect(ui.locator('.source-summary')).toContainText('引用 3 个来源');
    await ui.getByLabel('你的问题', { exact: true }).fill('结合这些材料继续说明。');
    const second = await sendPreview(), newId = second.state.conversations.find(c => c.externalId === second.draft.targetExternalId)!.id;
    expect(second.draft.sources.map(source => source.conversationId)).toEqual([sourceId, sourceId, secondId]);
    const parents = second.state.relations.filter(relation => relation.targetId === newId).map(relation => relation.source.conversationId);
    expect(parents).toEqual([sourceId, sourceId, secondId]); expect(second.state.conversations).toHaveLength(4);
    await expect(ui.locator('.conversation-node')).toHaveCount(4); await expectArrows(3);
    state = await command({ type: 'node.tags', node: { conversationId: sourceId }, tags: ['研究', '灵感'] });
    const primary = state.tagEntries!.find(tag => tag.name === '灵感')!, questionId = state.conversations.find(c => c.id === sourceId)!.turns[0]!.id;
    await command({ type: 'node.tags', node: { conversationId: sourceId }, tags: ['研究', '灵感'], primaryTagId: primary.id });
    await command({ type: 'node.tags', node: { conversationId: sourceId, turnId: questionId }, tags: ['研究'] });
    const exported = await command({ type: 'backup.export' });
    await command({ type: 'data.clear' }); await command({ type: 'backup.import', data: JSON.parse(JSON.stringify(exported)) }); await command({ type: 'graph.activate', id: graphId });
    const restored = await command({ type: 'state.get' });
    expect(restored.relations).toEqual(exported.relations); expect(restored.tagEntries).toEqual(exported.tagEntries); expect(restored.questionMeta).toEqual(exported.questionMeta);
    expect(restored.conversations.find(c => c.id === sourceId)!.primaryTagId).toBe(primary.id);
    await expect(ui.locator('.conversation-node')).toHaveCount(4); await expect(ui.locator('.provenance-arrow')).toHaveCount(3);
    await ui.mouse.move(1, 1); await ui.screenshot({ path: 'artifacts/unifai-v037-provenance-extension.png' });
  } finally {
    await context?.close(); const resolved = path.resolve(profile);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('unifai-provenance-')) throw new Error('Unexpected temporary profile path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
