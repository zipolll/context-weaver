import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInitialState } from '../../src/core/state';
import { newGraph } from '../../src/core/workspace';
import type { AppCommand, AppState, Conversation } from '../../src/core/types';

test('visible 111 survives stale history, long answers and hydration; failed searches restore position and warn', async () => {
  const temporaryRoot = path.resolve(os.tmpdir()), profile = fs.mkdtempSync(path.join(temporaryRoot, 'unifai-locate-'));
  let context: BrowserContext | undefined;
  const answer = '这是对111的特定回答，只用于验证完整消息和旧记录之间的定位，正确识别后应该停在这一条提问。';
  const questions = ['马尔奖含金量', '哪些中国人获得过', '亚历克山大王的履历', '111', '111', '111', '页面中不存在的目标'];
  const answers = ['第一段长回答', '第二段长回答', '第三段长回答', '旧的临时回答记录', answer, '', ''];
  const url = 'https://chat.deepseek.com/a/chat/s/recording-regression';
  try {
    const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (fs.existsSync(localChrome) ? localChrome : undefined), ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'], viewport: { width: 1180, height: 860 } });
    const protocol = await context.browser()!.newBrowserCDPSession(); await protocol.send('Extensions.loadUnpacked', { path: path.resolve('.output/chrome-mv3') });
    let render = 0;
    await context.route('https://chat.deepseek.com/**', route => {
      if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
      const sequence = ++render;
      const messages = [0, 1, 2, 4].map((index, position) => `<article data-virtual-list-item-key="live-${sequence}-${index}"><div class="_9663006"><div class="fbb737a4">${index === 4 ? '\u200b111\u2060' : questions[index]}</div></div></article><article class="answer ${index === 4 ? 'last' : ''}" ${index === 4 ? 'hidden' : ''} style="min-height:${[800, 2300, 1500, 160][position]}px"><div class="ds-assistant-message-main-content">${answers[index]}</div></article>`).join('');
      const script = `<script>const main=document.querySelector('main');window.moves=[];setTimeout(()=>{document.querySelector('.last').hidden=false;main.scrollTo({top:main.scrollHeight-main.clientHeight,behavior:'instant'});window.initialTop=main.scrollTop;window.ready=true;main.addEventListener('scroll',()=>window.moves.push(main.scrollTop));},500);setTimeout(()=>document.querySelectorAll('[data-virtual-list-item-key]').forEach((node,index)=>node.dataset.virtualListItemKey='hydrated-${sequence}-'+index),700);</script>`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>定位回归 - DeepSeek</title><style>body{margin:0;font:16px/1.8 sans-serif}main{height:760px;overflow-y:auto;scroll-behavior:smooth;padding:16px}.fbb737a4{padding:12px;background:#edf2ff;border-radius:14px;width:max-content;margin-left:auto}.answer{padding-top:15px}form{height:50px}</style></head><body><main>${messages}</main><form><textarea id="chat-input"></textarea></form>${script}</body></html>` });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const site = await context.newPage(); await site.goto(url); await site.waitForFunction(() => (window as any).ready);
    const tabId = await worker.evaluate(async value => (await chrome.tabs.query({ url: value }))[0]!.id!, url); await worker.evaluate(async id => chrome.storage.session.set({ lastWebTab: id }), tabId);
    const ui = await context.newPage(); await ui.goto('chrome-extension://' + new URL(worker.url()).host + '/sidepanel.html');
    const conversation: Conversation = { id: 'recording', site: 'deepseek', externalId: 'recording-regression', url, title: '录屏定位回归', customTitle: true, containerId: null, tags: [], starred: false, archived: false, complete: false,
      turns: questions.map((user, index) => ({ id: 'recording-regression:message:saved-' + index, user, assistant: answers[index]!, index, fingerprint: 'saved-' + index })), createdAt: 1, updatedAt: 1 };
    const graph = { ...newGraph('定位回归'), id: 'locate-graph', conversationIds: [conversation.id] };
    async function command(command: AppCommand): Promise<AppState> { const reply = await ui.evaluate(async cmd => chrome.runtime.sendMessage({ channel: 'context-weaver', command: cmd }), command); expect(reply.ok, reply.error).toBe(true); return reply.data; }
    await command({ type: 'backup.import', data: { ...createInitialState(), conversations: [conversation], graphs: [graph], activeGraphId: graph.id, openMode: 'tab' } });
    await command({ type: 'graph.activate', id: graph.id }); await command({ type: 'openMode.save', mode: 'tab' });
    await expect(ui.locator('.conversation-node')).toHaveCount(1); await ui.locator('.conversation-node').click(); await expect(ui.locator('.question-node')).toHaveCount(7);
    async function openQuestion(index: number): Promise<Page> {
      const opened = context!.waitForEvent('page'); await ui.locator('.question-node').nth(index).dblclick(); const target = await opened;
      await target.goto(url); await target.waitForFunction(() => (window as any).ready); return target;
    }
    const target = await openQuestion(4), bubble = target.locator('._9663006 .fbb737a4').last();
    await expect(bubble).toHaveCSS('outline-style', 'solid');
    const state = await command({ type: 'state.get' }); expect(state.conversations).toHaveLength(1); expect(state.conversations[0]!.turns).toHaveLength(7);
    const position = await target.locator('main').evaluate(element => element.scrollTop);
    await target.waitForTimeout(1000); expect(await target.locator('main').evaluate(element => element.scrollTop)).toBeCloseTo(position, 0);
    const search = await target.evaluate(() => ({ initial: (window as any).initialTop, moves: (window as any).moves as number[] }));
    expect(search.moves.every(value => value >= search.initial - 80)).toBe(true);
    await expect(ui.locator('.banner.warning')).toHaveCount(0); await expect(ui.locator('.banner.success')).toHaveCount(0);
    await target.screenshot({ path: 'artifacts/unifai-v037-111-located.png' });
    const ambiguous = await openQuestion(5);
    await expect(ui.locator('.banner.warning')).toContainText('已找到相同文字');
    await expect(ui.locator('.banner.warning')).toHaveAttribute('role', 'alert'); await expect(ui.locator('.banner.success')).toHaveCount(0);
    const initial = await ambiguous.evaluate(() => (window as any).initialTop as number);
    expect(await ambiguous.locator('main').evaluate(element => element.scrollTop)).toBeCloseTo(initial, 0);
    await ui.screenshot({ path: 'artifacts/unifai-v037-locate-warning.png' });
    await ui.getByLabel('关闭提示').click(); await ui.locator('.react-flow__controls-fitview').click();
    const missing = await openQuestion(6);
    await expect(ui.locator('.banner.warning')).toContainText('未能定位到该提问', { timeout: 13000 });
    const missingInitial = await missing.evaluate(() => (window as any).initialTop as number);
    expect(await missing.locator('main').evaluate(element => element.scrollTop)).toBeCloseTo(missingInitial, 0);
    await expect(ui.locator('.banner.success')).toHaveCount(0);
    await ui.screenshot({ path: 'artifacts/unifai-v037-locate-stopped.png' });
    const missingTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!.id!);
    const previous = command({ type: 'page.locate', tabId: missingTab, turnId: conversation.turns[6]!.id });
    await missing.waitForTimeout(1500);
    await Promise.all([previous, command({ type: 'page.locate', tabId: missingTab, turnId: conversation.turns[4]!.id })]);
    await expect(missing.locator('._9663006 .fbb737a4').last()).toHaveCSS('outline-style', 'solid');
    const afterClick = await missing.locator('main').evaluate(element => element.scrollTop);
    await missing.waitForTimeout(1000); expect(await missing.locator('main').evaluate(element => element.scrollTop)).toBeCloseTo(afterClick, 0);
  } finally {
    await context?.close(); const resolved = path.resolve(profile);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('unifai-locate-')) throw new Error('Unexpected temporary profile path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
