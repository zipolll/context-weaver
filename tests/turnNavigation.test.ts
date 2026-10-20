import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../src/adapters/deepseek';
import { ChatGPTAdapter } from '../src/adapters/chatgpt';
import { GeminiAdapter } from '../src/adapters/gemini';
import { createTurnNavigator } from '../src/adapters/turnNavigation';
import { createTurnLocation } from '../src/core/turnLocation';
import { captureSnapshot, createInitialState, exportBackup, updateCaptured, validateBackup } from '../src/core/state';
import { snapshotConversation } from '../src/core/context';
import type { SiteAdapter } from '../src/adapters/types';

const cases = [
  { make: () => new DeepSeekAdapter(document, () => 'https://chat.deepseek.com/a/chat/s/test'), html: '<div data-role="user" data-message-id="old-1">问题一</div><div data-role="assistant">回答一</div><div data-role="user" data-message-id="old-2">问题二</div><div data-role="assistant">回答二</div>', selector: '[data-role="user"]' },
  { make: () => new ChatGPTAdapter(document, () => 'https://chatgpt.com/c/test'), html: '<div data-message-author-role="user" data-message-id="old-1">问题一</div><div data-message-author-role="assistant">回答一</div><div data-message-author-role="user" data-message-id="old-2">问题二</div><div data-message-author-role="assistant">回答二</div>', selector: '[data-message-author-role="user"]' },
  { make: () => new GeminiAdapter(document, () => 'https://gemini.google.com/app/test'), html: '<user-query data-message-id="old-1"><div class="query-text">问题一</div></user-query><model-response><message-content>回答一</message-content></model-response><user-query data-message-id="old-2"><div class="query-text">问题二</div></user-query><model-response><message-content>回答二</message-content></model-response>', selector: 'user-query' },
];

describe('question navigation across page reloads', () => {
  afterEach(() => vi.useRealTimers());
  for (const fixture of cases) it(fixture.make().id + ' finds saved questions after DOM message IDs change', () => {
    document.body.innerHTML = fixture.html;
    const adapter = fixture.make(), saved = captureSnapshot(createInitialState(), adapter.readSnapshot()).conversation;
    const target = saved.turns[1]!, location = createTurnLocation(saved, target.id)!;
    document.querySelectorAll(fixture.selector).forEach((node, index) => node.setAttribute('data-message-id', 'new-' + index));
    const anchor = adapter.navigationAnchors()[1]!.element, scroll = vi.fn(); anchor.scrollIntoView = scroll;
    expect(adapter.locateTurn(target.id)).toBe(false);
    expect(adapter.locateTurn(target.id, location)).toBe(true); expect(scroll).toHaveBeenCalledOnce();
    expect(adapter.locateTurn(target.id, { ...location, externalId: 'wrong-page' })).toBe(false);
    expect(scroll).toHaveBeenCalledOnce();
  });
  it('distinguishes repeated questions and declines ambiguous unloaded occurrences', () => {
    document.body.innerHTML = '<div data-role="user" data-message-id="one">开始</div><div data-role="user" data-message-id="two">继续</div><div data-role="user" data-message-id="three">过渡</div><div data-role="user" data-message-id="four">继续</div><div data-role="user" data-message-id="five">结束</div>';
    const adapter = cases[0]!.make(), saved = captureSnapshot(createInitialState(), adapter.readSnapshot()).conversation;
    const target = saved.turns[3]!, location = createTurnLocation(saved, target.id)!;
    document.querySelectorAll('[data-role="user"]').forEach((node, index) => node.setAttribute('data-message-id', 'changed-' + index));
    const anchors = adapter.navigationAnchors(), first = vi.fn(), second = vi.fn(); anchors[1]!.element.scrollIntoView = first; anchors[3]!.element.scrollIntoView = second;
    expect(adapter.locateTurn(target.id, location)).toBe(true); expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    document.body.innerHTML = '<div data-role="user" data-message-id="unknown">继续</div>';
    expect(adapter.locateTurn(target.id, location)).toBe(false);
    document.body.innerHTML = '<div data-role="user" data-message-id="other">开始</div><div data-role="user" data-message-id="four">继续</div>';
    expect(adapter.locateTurn(target.id, location)).toBe(false);
  });
  it('recognizes an already rendered 111 despite stale duplicate history and changed message IDs', () => {
    document.body.innerHTML = '<div data-role="user" data-message-id="start">亚历克山大王的履历</div><div data-role="assistant">一段很长的前序回答</div><div data-role="user" data-message-id="ghost">111</div><div data-role="assistant">旧的临时回答记录</div><div data-role="user" data-message-id="target">111</div><div data-role="assistant">你发的111我暂时没有看懂具体指什么，可以补充一下你的意图。</div>';
    const adapter = cases[0]!.make(), saved = captureSnapshot(createInitialState(), adapter.readSnapshot()).conversation;
    const target = saved.turns[2]!, location = createTurnLocation(saved, target.id)!;
    document.body.innerHTML = '<div data-role="user" data-message-id="new-start">亚历克山大王的履历</div><div data-role="assistant">一段很长的前序回答</div><div data-role="user" data-message-id="new-target">111</div><div data-role="assistant">你发的111我暂时没有看懂具体指什么，可以补充一下你的意图。</div>';
    const anchor = adapter.navigationAnchors()[1]!.element, scroll = vi.fn(); anchor.scrollIntoView = scroll;
    expect(adapter.locateTurn(target.id, location)).toBe(true); expect(scroll).toHaveBeenCalledOnce();
  });
  it('matches layout whitespace and zero-width marks without confusing different question content', () => {
    document.body.innerHTML = '<div data-role="user" data-message-id="old">111</div><div data-role="assistant">回答</div>';
    const adapter = cases[0]!.make(), saved = captureSnapshot(createInitialState(), adapter.readSnapshot()).conversation;
    const target = saved.turns[0]!, location = createTurnLocation(saved, target.id)!;
    document.body.innerHTML = '<div data-role="user" data-message-id="new">\u200b111\u2060</div><div data-role="assistant">回答</div>';
    expect(adapter.locateTurn(target.id, location)).toBe(true);
    document.body.innerHTML = '<div data-role="user" data-message-id="new">1111</div><div data-role="assistant">包含111的回答</div>';
    expect(adapter.locateTurn(target.id, location)).toBe(false);
  });
  it('does not scroll away when matching question text is already loaded but ambiguous', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main style="overflow-y:auto"><div id="question">111</div></main>';
    const container = document.querySelector('main')!, anchor = document.querySelector<HTMLElement>('#question')!;
    Object.defineProperties(container, { scrollHeight: { value: 20000 }, clientHeight: { value: 500 } }); container.scrollTop = 19000;
    const adapter = { id: 'deepseek', readSnapshot: () => ({ site: 'deepseek', externalId: 'test', turns: [{ id: 'live', user: '111', assistant: '', index: 0, fingerprint: 'f' }] }), locateTurn: () => false, navigationAnchors: () => [{ turnId: 'live', text: '111', element: anchor }] } as unknown as SiteAdapter;
    const navigate = createTurnNavigator(adapter), location = { site: 'deepseek', externalId: 'test', user: '111', index: 2, total: 5, occurrence: 1, occurrences: 2 };
    navigate('saved', location, 'request'); expect(container.scrollTop).toBe(19000);
    vi.advanceTimersByTime(1600); navigate('saved', location, 'request'); expect(container.scrollTop).toBe(19000);
  });
  it('retains canonical question IDs, aliases and frozen sources while the DOM hydrates', () => {
    document.body.innerHTML = cases[0]!.html;
    const adapter = cases[0]!.make(), initial = captureSnapshot(createInitialState(), adapter.readSnapshot());
    document.querySelectorAll('[data-role="user"]').forEach((node, index) => node.setAttribute('data-message-id', 'hydrated-' + index));
    const snapshot = adapter.readSnapshot();
    const pending = updateCaptured(initial.state, { ...snapshot, turns: snapshot.turns.map(turn => ({ ...turn, assistant: '' })) });
    expect(pending.conversations[0]!.turns).toHaveLength(2);
    const settled = updateCaptured(pending, snapshot), turns = settled.conversations[0]!.turns;
    expect(turns.map(turn => turn.id)).toEqual(initial.conversation.turns.map(turn => turn.id));
    expect(turns[1]!.aliases).toContain(snapshot.turns[1]!.id);
    expect(validateBackup(exportBackup(settled)).conversations[0]!.turns[1]!.aliases).toContain(snapshot.turns[1]!.id);
    expect(snapshotConversation(settled.conversations[0]!, snapshot.turns[1]!.id).turnIds).toEqual(turns.map(turn => turn.id));
    const repeated = updateCaptured(settled, { ...snapshot, turns: [...snapshot.turns, { ...snapshot.turns[1]!, id: 'genuinely-new-question', assistant: '' }] });
    expect(repeated.conversations[0]!.turns).toHaveLength(3);
  });
  it('does not add ghost history when invisible text marks change during a reload', () => {
    document.body.innerHTML = '<div data-role="user" data-message-id="old">111</div><div data-role="assistant">这是完整的回答内容，用于检验重载之后的格式标记不会制造新的问题记录。</div>';
    const adapter = cases[0]!.make(), saved = captureSnapshot(createInitialState(), adapter.readSnapshot());
    document.body.innerHTML = '<div data-role="user" data-message-id="new">\u200b111\u2060</div><div data-role="assistant">\u200b这是完整的回答内容，用于检验重载之后的格式标记不会制造新的问题记录。\u2060</div>';
    const next = updateCaptured(saved.state, adapter.readSnapshot());
    expect(next.conversations[0]!.turns).toHaveLength(1); expect(next.conversations[0]!.turns[0]!.id).toBe(saved.conversation.turns[0]!.id);
    expect(next.conversations[0]!.turns[0]!.aliases).toContain('test:message:new');
  });
  it('searches a virtual scroll container and restores its position on bounded failure', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main style="overflow-y:auto"><div id="question">当前问题</div></main>';
    const container = document.querySelector('main')!, anchor = document.querySelector<HTMLElement>('#question')!;
    Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } }); container.scrollTop = 800;
    const locate = vi.fn(() => false), adapter = { id: 'deepseek', readSnapshot: () => ({ site: 'deepseek', externalId: 'test', turns: [{ id: 'q', user: '当前问题', assistant: '', index: 0, fingerprint: 'f' }] }), locateTurn: locate, navigationAnchors: () => [{ turnId: 'q', text: '当前问题', element: anchor }] } as unknown as SiteAdapter;
    const navigate = createTurnNavigator(adapter), location = { site: 'deepseek', externalId: 'test', user: '目标', index: 1, total: 10, occurrence: 0, occurrences: 1 };
    expect(navigate('saved', location, 'request')).toBe('pending'); expect(container.scrollTop).toBe(800);
    vi.advanceTimersByTime(1000); expect(navigate('saved', location, 'request')).toBe('pending'); expect(container.scrollTop).toBe(500);
    for (let i = 0; i < 25; i++) { vi.advanceTimersByTime(400); navigate('saved', location, 'request'); }
    expect(container.scrollTop).toBe(800);
    locate.mockReturnValue(true); expect(navigate('saved', location, 'next-request')).toBe('found');
    navigate.finish('next-request'); locate.mockReturnValue(false); expect(navigate('saved', location, 'next-request')).toBe('found');
  });
  it('cancels only the matching search and never scrolls during a verification pass', () => {
    vi.useFakeTimers(); document.body.innerHTML = '<main style="overflow-y:auto"><div id="question">当前问题</div></main>';
    const container = document.querySelector('main')!, anchor = document.querySelector<HTMLElement>('#question')!;
    Object.defineProperties(container, { scrollHeight: { value: 4000 }, clientHeight: { value: 400 } }); container.scrollTop = 1600;
    const locate = vi.fn(() => false), adapter = { id: 'deepseek', readSnapshot: () => ({ site: 'deepseek', externalId: 'test', turns: [{ id: 'q', user: '当前问题', assistant: '', index: 0, fingerprint: 'f' }] }), locateTurn: locate, navigationAnchors: () => [{ turnId: 'q', text: '当前问题', element: anchor }] } as unknown as SiteAdapter;
    const navigate = createTurnNavigator(adapter), location = { site: 'deepseek', externalId: 'test', user: '目标', index: 1, total: 10, occurrence: 0, occurrences: 1 };
    navigate('saved', location, 'old'); vi.advanceTimersByTime(1000); navigate('saved', location, 'old'); expect(container.scrollTop).toBe(1300);
    navigate('saved', location, 'new'); vi.advanceTimersByTime(1000); navigate('saved', location, 'new'); expect(container.scrollTop).toBe(1000);
    navigate.cancel('old'); expect(container.scrollTop).toBe(1000);
    vi.advanceTimersByTime(1000); expect(navigate('saved', location, 'new', true)).toBe('pending'); expect(container.scrollTop).toBe(1000);
    navigate.cancel('new'); expect(container.scrollTop).toBe(1300);
  });
  it('keeps genuinely identical repeated questions ambiguous when their answers are also identical', () => {
    const answer = '这是相同的长回答，无法单靠这一段文字区分是哪一次重复提问。';
    document.body.innerHTML = `<div data-role="user" data-message-id="first">111</div><div data-role="assistant">${answer}</div><div data-role="user" data-message-id="second">111</div><div data-role="assistant">${answer}</div>`;
    const adapter = cases[0]!.make(), saved = captureSnapshot(createInitialState(), adapter.readSnapshot()).conversation, target = saved.turns[1]!;
    const location = createTurnLocation(saved, target.id)!;
    document.body.innerHTML = `<div data-role="user" data-message-id="unknown">111</div><div data-role="assistant">${answer}</div>`;
    expect(adapter.locateTurn(target.id, location)).toBe(false);
  });
});
