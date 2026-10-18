import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter, deepseekConversationId } from '../src/adapters/deepseek';

const fixture = readFileSync(resolve('tests/fixtures/deepseek.html'), 'utf8');
function setup(html = fixture, path = '/a/chat/s/abc-123') {
  document.documentElement.innerHTML = html;
  document.getSelection()?.removeAllRanges();
  let url = 'https://chat.deepseek.com' + path;
  const adapter = new DeepSeekAdapter(document, () => url);
  return { dom: { reconfigure(options: { url: string }) { url = options.url; } }, adapter, document };
}
describe('DeepSeek conversation identity', () => {
  it('accepts saved URLs and rejects roots, reserved routes and foreign domains', () => {
    expect(deepseekConversationId('https://chat.deepseek.com/a/chat/s/c90-ABC?x=1')).toBe('c90-ABC');
    expect(deepseekConversationId('https://chat.deepseek.com/a/chat/c90-ABC')).toBe('c90-ABC');
    for (const path of ['/', '/a/chat', '/a/chat/', '/a/chat/s/', '/a/chat/new', '/a/chat/settings', '/a/chat/s/login', '/a/chat/s/abc/more']) expect(deepseekConversationId('https://chat.deepseek.com' + path)).toBeNull();
    expect(deepseekConversationId('https://chat.deepseek.com.evil.test/a/chat/s/123')).toBeNull();
  });
  it('follows navigation instead of attaching new page content to old ID', () => {
    const { dom, adapter } = setup();
    expect(adapter.readSnapshot().externalId).toBe('abc-123');
    dom.reconfigure({ url: 'https://chat.deepseek.com/a/chat/s/second' });
    expect(adapter.readSnapshot().externalId).toBe('second');
    expect(adapter.readSnapshot().turns[0]!.id).toMatch(/^second:/);
  });
});
describe('DeepSeek extraction', () => {
  it('groups user/answer pairs, ignores reasoning and controls, and marks DOM history incomplete', () => {
    const { adapter } = setup();
    const snapshot = adapter.readSnapshot();
    expect(snapshot.title).toBe('线性代数');
    expect(snapshot.complete).toBe(false);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({ id: 'abc-123:message:u1', user: '什么是特征向量？', index: 0 });
    expect(snapshot.turns[0]!.assistant).toBe('在线性变换后方向不变的向量。\nAv = λv');
    expect(JSON.stringify(snapshot)).not.toMatch(/思考|复制|导航侧栏|旧分支|附件卡片/);
  });
  it('retains turn identity during streamed answer changes', () => {
    const { adapter, document } = setup();
    const before = adapter.readSnapshot().turns;
    document.querySelectorAll('.ds-markdown p')[1]!.append(' x = (1,0)。');
    const after = adapter.readSnapshot().turns;
    expect(after.map(turn => turn.id)).toEqual(before.map(turn => turn.id));
    expect(after[1]!.assistant).toContain('x = (1,0)');
  });
  it('supports semantic wrappers without double counting nested answers', () => {
    const { adapter } = setup('<div data-message-author-role="user" data-message-id="u1">你好</div><div data-message-author-role="assistant"><div data-role="reasoning">秘密</div><div class="ds-assistant-message-main-content"><p>您好</p></div></div>');
    expect(adapter.readSnapshot().turns).toEqual([expect.objectContaining({ user: '你好', assistant: '您好' })]);
  });
  it('supports old message selectors while excluding reasoning', () => {
    const { adapter } = setup('<div class="ds-message _63c77b1"><div class="fbb737a4">问题</div></div><div class="ds-message"><div class="ds-think-content"><div class="ds-markdown">思考</div></div><div class="ds-markdown"><p>答案</p></div></div>');
    expect(adapter.readSnapshot().turns[0]).toMatchObject({ user: '问题', assistant: '答案' });
  });
  it('fails explicitly on unknown layouts and unsaved conversation pages', () => {
    expect(() => setup('<main>未知结构</main>').adapter.readSnapshot()).toThrow('未识别');
    expect(() => setup(fixture, '/').adapter.readSnapshot()).toThrow('尚未生成');
  });
  it('gives repeated prompts distinct fallback identities', () => {
    const { adapter } = setup('<div data-role="user">继续</div><div data-role="assistant">第一条</div><div data-role="user">继续</div>');
    const turns = adapter.readSnapshot().turns;
    expect(turns[0]!.id).not.toBe(turns[1]!.id);
    expect(turns[1]!.assistant).toBe('');
  });
  it('locates a visible turn and declines absent turns', () => {
    const { adapter, document } = setup();
    const node = document.querySelector('._9663006 .fbb737a4') as HTMLElement;
    const scroll = vi.fn(); node.scrollIntoView = scroll;
    expect(adapter.locateTurn('abc-123:message:u1')).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(adapter.locateTurn('missing')).toBe(false);
  });
});
describe('DeepSeek safe composer and selection', () => {
  it('appends to existing text, dispatches input, and never submits or clicks', () => {
    const { adapter, document } = setup();
    const textarea = document.querySelector('textarea')!;
    textarea.value = '已有草稿';
    const input = vi.fn(); const submit = vi.fn(); const click = vi.fn(); const keydown = vi.fn();
    textarea.addEventListener('input', input); document.addEventListener('submit', submit); document.addEventListener('click', click); document.addEventListener('keydown', keydown);
    adapter.fillComposer('新上下文', 'append');
    expect(adapter.readComposer()).toBe('已有草稿\n\n新上下文');
    expect(input).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled(); expect(keydown).not.toHaveBeenCalled();
    adapter.fillComposer('替换草稿', 'replace');
    expect(adapter.readComposer()).toBe('替换草稿');
  });
  it('does not mutate a disabled or ambiguous composer', () => {
    const disabled = setup('<textarea id="chat-input" disabled>原文</textarea>');
    expect(() => disabled.adapter.fillComposer('覆盖', 'replace')).toThrow('暂不可用');
    expect(disabled.document.querySelector('textarea')!.value).toBe('原文');
    const ambiguous = setup('<textarea id="chat-input"></textarea><textarea placeholder="Message"></textarea>');
    expect(() => ambiguous.adapter.fillComposer('覆盖', 'replace')).toThrow('无法唯一识别');
  });
  it('fills a contenteditable composer without creating markup from input', () => {
    const { adapter, document } = setup('<div contenteditable="true" role="textbox">先前</div>');
    adapter.fillComposer('<img src=x>', 'append');
    expect(adapter.readComposer()).toBe('先前\n\n<img src=x>');
    expect(document.querySelector('img')).toBeNull();
  });
  it('attributes an answer selection to its user turn', () => {
    const { adapter, document } = setup();
    const paragraph = document.querySelector('.ds-assistant-message-main-content p')!;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    document.getSelection()!.addRange(range);
    expect(adapter.readSelection()).toMatchObject({ text: '在线性变换后方向不变的向量。', turnId: 'abc-123:message:u1' });
  });
});
