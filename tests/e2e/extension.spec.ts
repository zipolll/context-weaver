import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let context: BrowserContext, worker: Worker, ui: Page, site: Page, base: string, profile: string;
const fixture = fs.readFileSync(path.resolve('tests/fixtures/deepseek.html'), 'utf8');
const fixturePage = (title: string, content = fixture) => content.replace('<title>线性代数 - DeepSeek</title>', '<title>' + title + ' - DeepSeek</title>').replace('</body>', '<script>window.submitCount=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submitCount++;})</script></body>');
async function command<T = any>(cmd: object): Promise<T> { const response = await ui.evaluate(async c => chrome.runtime.sendMessage({ channel: 'context-weaver', command: c }), cmd); expect(response.ok, response.error).toBe(true); return response.data; }
async function currentTab(): Promise<number> { return worker.evaluate(async () => { const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/a/chat/s/source' }); return tabs[0]!.id!; }); }
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'context-weaver-e2e-'));
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath && !fs.existsSync(chromium.executablePath()) && process.platform === 'win32') {
    const cache = path.join(process.env.LOCALAPPDATA!, 'ms-playwright');
    executablePath = fs.readdirSync(cache).filter(x => /^chromium-\d+$/.test(x)).map(x => path.join(cache, x, 'chrome-win64', 'chrome.exe')).find(x => fs.existsSync(x));
  }
  const extensionPath = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, executablePath, args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath], viewport: { width: 390, height: 900 } });
  await context.route('https://chat.deepseek.com/**', route => {
    const url = new URL(route.request().url());
    const html = url.pathname === '/' ? '<!doctype html><html><head><title>DeepSeek</title></head><body><main></main><form><textarea id="chat-input"></textarea><button>发送</button></form><script>window.submitCount=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submitCount++;})</script></body></html>' : fixturePage(url.pathname.endsWith('source') ? '线性代数' : '第二个来源');
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); base = 'chrome-extension://' + new URL(worker.url()).host;
  site = await context.newPage(); await site.goto('https://chat.deepseek.com/a/chat/s/source');
  await expect(site.locator('#chat-input')).toBeVisible();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chat.deepseek.com/a/chat/s/source' }))[0]!.id!);
  await worker.evaluate(async id => chrome.storage.session.set({ lastWebTab: id }), tabId);
  ui = await context.newPage(); await ui.goto(base + '/sidepanel.html');
  await expect(ui.getByRole('button', { name: '新建项目', exact: true })).toBeVisible();
});
test.afterAll(async () => { await context?.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
test('capture, organize, search, archive, reload and prevent folder cycles', async () => {
  const errors: string[] = []; ui.on('pageerror', e => errors.push(e.message));
  await ui.getByRole('button', { name: '收纳当前页面' }).click();
  await expect(ui.locator('.conversation-title')).toHaveText('线性代数');
  await ui.getByRole('button', { name: '新建项目', exact: true }).click(); await ui.getByLabel('项目名称').fill('科研线索'); await ui.getByRole('button', { name: '保存目录' }).click();
  await expect(ui.locator('.folder-label')).toHaveText('科研线索');
  await ui.getByRole('button', { name: '在 科研线索 新建文件夹' }).click(); await ui.getByLabel('文件夹名称').fill('线性代数'); await ui.getByRole('button', { name: '保存目录' }).click();
  await ui.getByRole('button', { name: '编辑', exact: true }).click(); await ui.getByLabel('对话标题').fill('矩阵与特征向量'); await ui.getByLabel('标签（逗号分隔）').fill('数学, 复习');
  await ui.getByLabel('所属目录').selectOption({ label: '科研线索 / 线性代数' }); await ui.getByRole('button', { name: '保存修改' }).click();
  await ui.getByRole('button', { name: '收藏', exact: true }).last().click();
  await ui.getByLabel('搜索对话').fill('方向不变'); await expect(ui.locator('.conversation-title')).toHaveText('矩阵与特征向量');
  await ui.getByLabel('搜索对话').fill('不会出现的文本'); await expect(ui.locator('.conversation')).toHaveCount(0); await ui.getByLabel('搜索对话').fill('');
  await ui.getByRole('button', { name: '归档', exact: true }).last().click(); await expect(ui.locator('.conversation')).toHaveCount(0); await ui.getByRole('button', { name: '归档', exact: true }).first().click(); await expect(ui.locator('.conversation')).toHaveCount(1);
  await ui.getByRole('button', { name: '取消归档' }).click(); await ui.getByRole('button', { name: '全部', exact: true }).click(); await ui.reload(); await expect(ui.locator('.conversation-title')).toHaveText('矩阵与特征向量');
  const state = await command({ type: 'state.get' }); expect(state.conversations[0].tags).toEqual(['数学', '复习']); expect(state.conversations[0].starred).toBe(true);
  expect(errors).toEqual([]);
});
test('navigation, cutoff branches, draft restore, append protection and no automatic send', async () => {
  await ui.getByRole('button', { name: '当前对话', exact: true }).click(); await expect(ui.locator('.turn')).toHaveCount(2);
  await ui.locator('.turn-question').first().click(); await expect(site.locator('[data-virtual-list-item-key="u1"] .fbb737a4')).toHaveCSS('outline-style', 'solid');
  await ui.getByRole('button', { name: '从这里分支' }).first().click(); const dialog = ui.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.getByLabel('你的问题').fill('为什么方向不变？'); const prompt = dialog.locator('.prompt-editor'); await expect(prompt).toHaveValue(/为什么方向不变/);
  expect(await prompt.inputValue()).toContain('什么是特征向量'); expect(await prompt.inputValue()).not.toContain('考虑对角矩阵');
  await dialog.getByRole('button', { name: '保存草稿' }).click(); await dialog.getByRole('button', { name: '关闭预览' }).click();
  await ui.locator('.draft-drawer > summary').click(); await ui.locator('.draft-item').first().click(); await expect(prompt).toHaveValue(/为什么方向不变/);
  await site.locator('#chat-input').fill('已有手写问题'); await dialog.getByLabel('目标', { exact: true }).selectOption('current'); await expect(dialog.getByText('输入框已有内容', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '确认并填入输入框' }).click(); await expect(site.locator('#chat-input')).toHaveValue(/已有手写问题\n\n任务：继续追问/);
  expect(await site.evaluate(() => (window as any).submitCount)).toBe(0); await dialog.getByRole('button', { name: '关闭预览' }).click();
});
test('multiple sources create a new conversation and bind frozen provenance after user sends', async () => {
  const second = await context.newPage(); await second.goto('https://chat.deepseek.com/a/chat/s/second');
  const secondId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chat.deepseek.com/a/chat/s/second' }))[0]!.id!);
  await command({ type: 'conversation.capture', tabId: secondId });
  await worker.evaluate(async id => chrome.storage.session.set({ lastWebTab: id }), await currentTab());
  await ui.getByRole('button', { name: '项目', exact: true }).click(); await expect(ui.locator('.conversation')).toHaveCount(2);
  await ui.locator('.conversation input[type="checkbox"]').nth(0).check(); await ui.locator('.conversation input[type="checkbox"]').nth(1).check();
  await ui.getByRole('button', { name: '继承上下文', exact: true }).click(); const dialog = ui.getByRole('dialog'); await dialog.getByLabel('你的问题').fill('综合两个来源');
  await dialog.locator('.source-block > summary').first().click(); await dialog.getByRole('button', { name: '来源下移' }).first().click();
  const expectedTitles = await dialog.locator('.source-block > summary > span:nth-child(2)').allTextContents();
  await dialog.getByRole('button', { name: '保存草稿' }).click(); await dialog.getByRole('button', { name: '关闭预览' }).click();
  if (!(await ui.locator('.draft-drawer').getAttribute('open'))) await ui.locator('.draft-drawer > summary').click(); await ui.locator('.draft-item').first().click();
  expect(await dialog.locator('.source-block > summary > span:nth-child(2)').allTextContents()).toEqual(expectedTitles);
  const newPagePromise = context.waitForEvent('page'); await dialog.getByRole('button', { name: '确认并填入输入框' }).click(); const target = await newPagePromise;
  await expect(target.locator('#chat-input')).toHaveValue(/综合两个来源/); expect(await target.evaluate(() => (window as any).submitCount)).toBe(0);
  // Simulate the website rendering the message only after a user sends.
  await target.evaluate(() => { const text = (document.querySelector('#chat-input') as HTMLTextAreaElement).value; history.pushState({}, '', '/a/chat/s/merged'); const node = document.createElement('div'); node.setAttribute('data-message-author-role', 'user'); node.setAttribute('data-message-id', 'merge-first'); node.textContent = text; document.querySelector('main')!.append(node); });
  await expect.poll(async () => (await command({ type: 'state.get' })).relations.length).toBe(2);
  const state = await command({ type: 'state.get' }); expect(state.drafts.find((d: any) => d.question === '综合两个来源').status).toBe('bound');
  await dialog.getByRole('button', { name: '关闭预览' }).click(); await ui.getByRole('button', { name: '关系', exact: true }).click(); await expect(ui.locator('.cw-graph-node')).toHaveCount(3);
  await ui.screenshot({ path: 'artifacts/relationship-panel.png', fullPage: true });
});
test('selection intent, snippets, backup roundtrip and workspace layout', async () => {
  const tabId = await currentTab();
  await worker.evaluate(async id => { await chrome.storage.session.set({ lastWebTab: id, intent: { action: 'snippet', destination: 'new', selection: { text: '选中的重要定义', title: '线性代数', url: 'https://chat.deepseek.com/a/chat/s/source' }, tabId: id, nonce: 'test-intent' } }); await chrome.runtime.sendMessage({ channel: 'context-weaver', changed: true }).catch(() => undefined); }, tabId);
  await expect(ui.locator('.snippet blockquote')).toHaveText('选中的重要定义');
  await ui.getByRole('button', { name: '解释概念', exact: true }).click(); await expect(ui.getByRole('dialog').locator('.prompt-editor')).toHaveValue(/任务：解释概念/); await ui.getByRole('button', { name: '关闭预览' }).click();
  const backup = await command({ type: 'backup.export' }); expect(JSON.stringify(backup)).not.toContain('apiKey'); await command({ type: 'backup.import', data: backup }); expect((await command({ type: 'state.get' })).conversations).toHaveLength(3);
  await ui.getByRole('button', { name: '项目', exact: true }).click(); await ui.screenshot({ path: 'artifacts/library-panel.png', fullPage: true });
  const workspace = await context.newPage(); await workspace.setViewportSize({ width: 1280, height: 960 }); await workspace.goto(base + '/workspace.html'); await expect(workspace.locator('.cw-graph-node')).toHaveCount(3); await workspace.screenshot({ path: 'artifacts/workspace.png', fullPage: true });
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
