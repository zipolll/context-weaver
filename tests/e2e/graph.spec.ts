import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { applyCommand, createInitialState, captureSnapshot } from '../../src/core/state';
import { GRAPH_LAYOUT_VERSION, nodeKey, withWorkspace } from '../../src/core/workspace';
import type { AppCommand } from '../../src/core/types';

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (fs.existsSync(localChrome) ? localChrome : undefined) } });
const titles = ['从特征向量理解线性变换', '注意力机制与上下文窗口', '检索增强生成的设计取舍', '为知识图建立来源关系', '图谱的交互与视觉层次', '用问题串联学习路径', '跨平台复用对话上下文', '如何评估模型回答质量', '浏览器扩展的本地存储', '设计更自然的节点布局', '整理科研笔记与论文阅读', '让复杂信息保持清晰'];

async function openGraph(page: Page, count: number, width: number, questions = 12, tagged = false) {
  let state = createInitialState();
  for (let i = 0; i < count; i++) state = captureSnapshot(state, { site: 'deepseek', externalId: 'sample-' + i, url: 'https://chat.deepseek.com/a/chat/s/sample-' + i, title: titles[i % titles.length]!, sourceTitle: titles[i % titles.length]!, complete: true,
    turns: Array.from({ length: questions }, (_, index) => ({ id: 'q' + index, user: `第 ${index + 1} 个问题：如何把这个想法应用到实际学习中，并验证它的效果？`, assistant: '可以从一个具体例子开始，保留来源，再逐步验证。', index, fingerprint: 'f' + index })) }).state;
  state = withWorkspace(state);
  const ids = state.conversations.map(c => c.id);
  state.relations = ids.slice(1).map((id, index) => ({ id: 'r' + index, targetId: id, source: { id: 's' + index, conversationId: ids[Math.floor(index / 2)]!, title: '来源对话', url: 'https://chat.deepseek.com/a/chat/s/sample', turnIds: [], text: '来源', capturedAt: 1 }, createdAt: 1 }));
  if (tagged) {
    const names = [['研究', '灵感'], ['灵感'], ['待验证'], ['视觉'], ['灵感'], ['研究']];
    for (let i = 0; i < count; i++) state = applyCommand(state, { type: 'node.tags', node: { conversationId: ids[i]! }, tags: names[i % names.length]! });
    if (questions) state = applyCommand(state, { type: 'node.tags', node: { conversationId: ids[0]!, turnId: 'q0' }, tags: ['待验证'] });
    const relation = state.relations[0]!;
    state.relations.push({ ...relation, id: 'another-fragment', source: { ...relation.source, id: 'fragment', text: '同一来源的另一个片段' } });
  }
  state.graphs![0]!.name = '学习与灵感';
  state.graphs![0]!.positions = Object.fromEntries(ids.map((id, i) => [id, { x: i * 600, y: i * 400 }]));
  const errors: string[] = [], opened: AppCommand[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Graph page error:', error.message); });
  await page.setViewportSize({ width, height: 860 });
  await page.exposeFunction('sampleCommand', (command: AppCommand) => {
    try {
      let data: unknown;
      if (command.type === 'state.get') data = state;
      else if (command.type === 'platform.last') data = 'deepseek';
      else if (command.type === 'intent.claim') data = null;
      else if (command.type === 'page.active') data = { tabId: 1, url: state.conversations[0]!.url, title: titles[0], supported: true, site: 'deepseek' };
      else if (command.type === 'page.open') { opened.push(command); data = true; }
      else { state = applyCommand(state, command); data = state; }
      return { ok: true, data };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  await page.addInitScript(() => {
    const listeners = new Set<(event: unknown) => void>();
    (window as any).chrome = { runtime: { getURL: (p: string) => '/' + p, onMessage: { addListener: (l: (event: unknown) => void) => listeners.add(l), removeListener: (l: (event: unknown) => void) => listeners.delete(l) },
      sendMessage: async (message: { command: AppCommand }) => {
        const reply = await (window as any).sampleCommand(message.command);
        if (!['state.get', 'platform.last', 'page.active', 'intent.claim'].includes(message.command.type)) queueMicrotask(() => listeners.forEach(l => l({ channel: 'context-weaver', changed: true })));
        return reply;
      } }, tabs: { create: async () => ({ id: 1 }) } };
  });
  await page.route('http://127.0.0.1/**', async route => {
    const filename = path.join(process.cwd(), '.output/chrome-mv3', new URL(route.request().url()).pathname);
    try { await route.fulfill({ body: fs.readFileSync(filename), contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://127.0.0.1/sidepanel.html');
  await expect(page.locator('.conversation-node')).toHaveCount(count);
  await expect.poll(() => state.graphs![0]!.layoutVersion).toBe(GRAPH_LAYOUT_VERSION);
  await expect(page.locator('.brand-home')).toHaveText('UniFAI');
  await page.mouse.move(1, 1);
  return { state: () => structuredClone(state), errors, opened };
}

const screenPositions = (page: Page) => page.locator('.conversation-node').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; }));
const viewportTransform = (page: Page) => page.locator('.react-flow__viewport').getAttribute('style');

async function endpointError(page: Page, state: ReturnType<typeof createInitialState>) {
  const edges = state.relations.map(relation => ({ id: 'inherit-' + relation.id, source: relation.source.conversationId!, target: relation.targetId }));
  for (const conversation of state.conversations) for (const turn of conversation.turns) {
    const id = nodeKey({ conversationId: conversation.id, turnId: turn.id });
    edges.push({ id: 'question-' + id, source: conversation.id, target: id });
  }
  return page.evaluate(expected => {
    const nodes = new Map([...document.querySelectorAll('.react-flow__node')].map(node => [node.getAttribute('data-id'), node.querySelector('.canvas-dot')!.getBoundingClientRect()]));
    const paths = new Map([...document.querySelectorAll('.react-flow__edge')].map(edge => [edge.getAttribute('data-id'), edge.querySelector<SVGPathElement>('.react-flow__edge-path')!]));
    let maximum = 0;
    for (const edge of expected) {
      const path = paths.get(edge.id); if (!path) continue;
      const matrix = path.getScreenCTM()!;
      for (const [id, at] of [[edge.source, 0], [edge.target, path.getTotalLength()]] as const) {
        const point = path.getPointAtLength(at), screen = new DOMPoint(point.x, point.y).matrixTransform(matrix), node = nodes.get(id)!;
        maximum = Math.max(maximum, Math.hypot(screen.x - (node.x + node.width / 2), screen.y - (node.y + node.height / 2)));
      }
    }
    return maximum;
  }, edges);
}

test('lines meet dot centers after expansion, zoom and dragging', async ({ page }) => {
  const sample = await openGraph(page, 3, 420, 4), node = page.locator('.conversation-node').first();
  await node.click(); await expect(page.locator('.question-node')).toHaveCount(4);
  await expect.poll(() => endpointError(page, sample.state())).toBeLessThan(0.3);
  await page.locator('.react-flow__controls-zoomin').click({ clickCount: 3, delay: 100 });
  await expect.poll(() => endpointError(page, sample.state())).toBeLessThan(0.3);
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 65, box.y + 30, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => endpointError(page, sample.state())).toBeLessThan(0.3);
  await page.mouse.move(1, 1); await node.evaluate(element => (element as HTMLElement).blur());
  await page.screenshot({ path: 'artifacts/unifai-v037-centered-edges.png' });
  expect(sample.errors).toEqual([]);
});

test('migration, reversible expansion, drag persistence, menus and keyboard focus', async ({ page }) => {
  const sample = await openGraph(page, 3, 1180);
  const initial = sample.state(), graph = initial.graphs![0]!, node = page.locator('.conversation-node').first();
  const original = await screenPositions(page);
  expect(Math.hypot(original[1]!.x - original[0]!.x, original[1]!.y - original[0]!.y)).toBeLessThan(180);
  await page.screenshot({ path: 'artifacts/unifai-v037-compact.png' });
  for (let cycle = 0; cycle < 3; cycle++) {
    await node.click(); await expect(page.locator('.question-node')).toHaveCount(12);
    await page.waitForTimeout(350);
    const viewport = await viewportTransform(page);
    await expect.poll(() => sample.state().graphs![0]!.positions).toEqual(graph.positions);
    await page.waitForTimeout(650);
    expect(await viewportTransform(page)).toBe(viewport);
    await node.click(); await expect(page.locator('.question-node')).toHaveCount(0);
    await page.waitForTimeout(650);
  }
  const preservedViewport = await viewportTransform(page);
  await page.evaluate(async id => chrome.runtime.sendMessage({ channel: 'context-weaver', command: { type: 'graph.patch', id, patch: { name: '学习与灵感 · 已整理' } } }), graph.id);
  await expect(page.getByLabel('知识图名称')).toHaveValue('学习与灵感 · 已整理');
  expect(await viewportTransform(page)).toBe(preservedViewport);
  await node.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '加入暂存', exact: true }).click();
  expect(sample.state().staged).toHaveLength(1);
  await node.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '选择 Tag', exact: true }).click();
  await page.getByLabel('搜索或新建 Tag', { exact: true }).fill('灵感');
  await page.getByRole('button', { name: '新建“灵感”', exact: true }).click();
  await expect.poll(() => sample.state().conversations[0]!.tags).toContain('灵感');
  await page.getByLabel('关闭 Tag 选择').click();
  await node.dblclick(); await expect.poll(() => sample.opened.length).toBe(1);
  await expect(page.locator('.question-node')).toHaveCount(0);
  await node.focus(); await expect(node).toBeFocused(); await expect(page.getByRole('tooltip')).toContainText(titles[0]!);
  await node.press('Enter'); await expect(page.locator('.question-node')).toHaveCount(12);
  const q = page.locator('.question-node').first(); await q.hover();
  const tooltip = page.getByRole('tooltip'); await expect(tooltip).toHaveCount(1); await expect(tooltip).toBeVisible();
  const qb = (await q.boundingBox())!, tb = (await tooltip.boundingBox())!;
  expect(tb.x + tb.width <= qb.x || tb.x >= qb.x + qb.width || tb.y + tb.height <= qb.y || tb.y >= qb.y + qb.height).toBe(true);
  await page.mouse.move(1, 1); await node.evaluate(element => (element as HTMLElement).blur());
  const before = sample.state().graphs![0]!.positions[initial.conversations[0]!.id]!;
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 14, box.y + 14); await page.mouse.down(); await page.mouse.move(box.x + 94, box.y + 54, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => sample.state().graphs![0]!.positions[initial.conversations[0]!.id]!.x).toBeGreaterThan(before.x + 50);
  const saved = sample.state().graphs![0]!.positions;
  await page.reload(); await expect(page.locator('.conversation-node')).toHaveCount(3);
  await page.waitForTimeout(700); expect(sample.state().graphs![0]!.positions).toEqual(saved);
  expect(sample.state().graphs![0]!.positions[nodeKey({ conversationId: initial.conversations[0]!.id, turnId: 'q0' })]).toBeDefined();
  expect(sample.errors).toEqual([]);
});

for (const [width, count, questions] of [[320, 1, 0], [320, 3, 12], [420, 12, 1], [1180, 12, 12], [420, 30, 30]] as const) {
  test(`visual layout ${width}px, ${count} conversations, ${questions} questions`, async ({ page }) => {
    const sample = await openGraph(page, count, width, questions);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `artifacts/unifai-v037-${width}-${count}.png` });
    if (count === 30) {
      await page.locator('.react-flow__controls-zoomout').click({ clickCount: 2, delay: 100 });
      await expect.poll(() => page.locator('.canvas-label').evaluateAll(labels => labels.every(label => getComputedStyle(label).opacity === '0'))).toBe(true);
      await page.locator('.react-flow__controls-zoomin').click({ clickCount: 2, delay: 100 });
    }
    const node = page.locator('.conversation-node').first();
    await node.click(); await expect(page.locator('.question-node')).toHaveCount(questions);
    await page.mouse.move(1, 1); await node.evaluate(element => (element as HTMLElement).blur());
    await page.waitForTimeout(650);
    await page.screenshot({ path: `artifacts/unifai-v037-${width}-${count}-expanded.png` });
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBe(width);
    if (count === 3) expect(await node.locator('.canvas-label').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await node.click(); await expect(page.locator('.question-node')).toHaveCount(0);
    expect(sample.errors).toEqual([]);
  });
}

async function arrowErrors(page: Page) {
  return page.locator('.react-flow__edge-provenance').evaluateAll(edges => edges.map(edge => {
    const line = edge.querySelector<SVGPathElement>('.react-flow__edge-path')!, arrow = edge.querySelector<SVGPathElement>('.provenance-arrow')!;
    const from = line.getPointAtLength(0), to = line.getPointAtLength(line.getTotalLength()), tip = arrow.getPointAtLength(arrow.getTotalLength() / 2), arm = arrow.getPointAtLength(0);
    const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
    return { perpendicular: Math.abs((tip.x - from.x) * dy - (tip.y - from.y) * dx) / length, fraction: ((tip.x - from.x) * dx + (tip.y - from.y) * dy) / (length * length), direction: (tip.x - arm.x) * dx + (tip.y - arm.y) * dy };
  }));
}
const rgb = (hex: string) => 'rgb(' + [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ') + ')';

for (const width of [320, 420, 1180]) {
  test(`directed sources and independent Tag colors at ${width}px`, async ({ page }) => {
    const sample = await openGraph(page, 6, width, 4, true), original = sample.state(), node = page.locator('.conversation-node').first();
    const tag = (name: string) => sample.state().tagEntries!.find(t => t.name === name)!;
    const initialColor = rgb(tag('研究').color!);
    await expect(page.locator('.provenance-arrow')).toHaveCount(5);
    await expect(node.locator('.canvas-dot')).toHaveCSS('background-color', initialColor);
    await node.click(); await expect(page.locator('.question-node')).toHaveCount(4);
    await node.hover(); await expect(node.locator('.canvas-dot')).toHaveCSS('background-color', initialColor);
    await expect.poll(() => endpointError(page, sample.state())).toBeLessThan(0.3);
    for (const arrow of await arrowErrors(page)) { expect(arrow.perpendicular).toBeLessThan(0.02); expect(arrow.fraction).toBeGreaterThan(0.5); expect(arrow.fraction).toBeLessThan(0.8); expect(arrow.direction).toBeGreaterThan(0); }
    const highlighted = await page.locator('.react-flow__edge-provenance').first().evaluate(edge => ({ line: getComputedStyle(edge.querySelector('.react-flow__edge-path')!).stroke, arrow: getComputedStyle(edge.querySelector('.provenance-arrow')!).stroke }));
    expect(highlighted.arrow).toBe(highlighted.line);
    await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } }); await node.evaluate(element => (element as HTMLElement).blur()); await page.mouse.move(1, 1);
    await page.waitForTimeout(180); await page.screenshot({ path: `artifacts/unifai-v037-${width}-tags.png` });
    await node.click({ button: 'right' }); await page.getByRole('menuitem', { name: '选择 Tag', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '选择节点 Tag' }); await expect(panel).toBeVisible();
    await page.getByRole('radio', { name: '将 灵感 设为主色' }).check();
    await expect.poll(() => sample.state().conversations[0]!.primaryTagId).toBe(tag('灵感').id);
    await expect(node.locator('.canvas-dot')).toHaveCSS('background-color', rgb(tag('灵感').color!));
    const bounds = (await panel.boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 7); expect(bounds.y + bounds.height).toBeLessThanOrEqual(853);
    await page.screenshot({ path: `artifacts/unifai-v037-${width}-tag-picker.png` });
    await page.getByLabel('搜索或新建 Tag').fill('待验证');
    await page.getByRole('checkbox', { name: '选择 Tag 待验证', exact: true }).check();
    await expect.poll(() => sample.state().conversations[0]!.tags).toEqual(['研究', '灵感', '待验证']);
    expect(sample.state().conversations[0]!.primaryTagId).toBe(tag('灵感').id);
    await page.getByLabel('搜索或新建 Tag').fill('新想法'); await page.getByRole('button', { name: '新建“新想法”' }).click();
    await expect.poll(() => sample.state().conversations[0]!.tags).toContain('新想法');
    expect(tag('新想法').color).toMatch(/^#[0-9a-f]{6}$/); expect(new Set(sample.state().tagEntries!.map(t => t.color)).size).toBe(sample.state().tagEntries!.length);
    await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
    const q = page.locator('.question-node').first(); await expect(q.locator('.canvas-dot')).toHaveCSS('background-color', rgb(tag('待验证').color!));
    await expect(page.locator('.question-node').nth(1)).not.toHaveAttribute('data-tagged');
    await q.click({ button: 'right' }); await page.getByRole('menuitem', { name: '选择 Tag' }).click();
    await page.getByRole('button', { name: '清空 Tag', exact: true }).click();
    await expect.poll(() => sample.state().questionMeta![0]!.tags).toEqual([]); await expect(q).not.toHaveAttribute('data-tagged');
    await page.getByRole('checkbox', { name: '选择 Tag 灵感', exact: true }).check();
    await expect.poll(() => sample.state().questionMeta![0]!.primaryTagId).toBe(tag('灵感').id);
    await page.keyboard.press('Escape'); await expect(q.locator('.canvas-dot')).toHaveCSS('background-color', rgb(tag('灵感').color!));
    expect(sample.state().conversations[0]!.primaryTagId).toBe(tag('灵感').id);
    await q.dblclick(); await expect.poll(() => sample.opened.length).toBe(1); expect(sample.opened[0]).toMatchObject({ type: 'page.open', turnId: 'q0' });
    const graphId = sample.state().activeGraphId!, positions = sample.state().graphs!.find(g => g.id === graphId)!.positions;
    await page.reload(); await expect(node.locator('.canvas-dot')).toHaveCSS('background-color', rgb(tag('灵感').color!));
    await expect.poll(() => sample.state().graphs!.find(g => g.id === graphId)!.positions).toEqual(positions);
    expect(sample.state().graphs!.find(g => g.id === graphId)!.layoutVersion).toBe(original.graphs![0]!.layoutVersion);
    expect(sample.errors).toEqual([]);
  });
}
