import type { PageSnapshot, SelectionSnapshot, Turn } from '../core/types';
import type { SiteAdapter } from './types';
import { buttonFor, candidates, locate, normalizeText } from './dom';

/** Public DOM evidence: NIyueeE/deepseek-user-message-renderer (2026).
 * Current user text: ._9663006 .fbb737a4; final answer: .ds-assistant-message-main-content.
 * Semantic attributes are preferred when supplied. Opaque selectors stay isolated
 * here, and unrecognized pages fail explicitly instead of capturing unrelated text.
 */
export const DEEPSEEK_SELECTORS = {
  user: '[data-message-author-role="user"], [data-role="user"], [data-testid="user-message"], ._9663006 .fbb737a4, .ds-message._63c77b1 .fbb737a4',
  assistant: '[data-message-author-role="assistant"], [data-role="assistant"], [data-testid="assistant-message"], .ds-assistant-message-main-content',
  reasoning: '[data-role="reasoning"], [data-testid*="reasoning"], [data-testid*="thinking"], .ds-think-content, .ds-think, [class*="ds-think"], .ds-collapsible-text-toggle-button, details, [aria-hidden="true"], [hidden], script, style, button',
  composer: 'textarea#chat-input, textarea[data-testid="chat-input"], textarea[placeholder*="DeepSeek"], textarea[placeholder*="发送消息"], textarea[placeholder*="Message"], [contenteditable="true"][role="textbox"]',
} as const;

export function deepseekConversationId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chat.deepseek.com') return null;
    const match = /^\/a\/chat\/(?:s\/)?([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    const id = match?.[1];
    if (!id || ['new', 's', 'history', 'settings', 'login'].includes(id.toLowerCase())) return null;
    return id;
  } catch { return null; }
}
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (const char of value.replace(/\s+/g, ' ').trim()) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
function visible(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  let node: Element | null = element;
  while (node && node !== element.ownerDocument.body) {
    const style = view?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    node = node.parentElement;
  }
  return true;
}
function textContent(element: Element): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(DEEPSEEK_SELECTORS.reasoning).forEach(node => node.remove());
  clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  clone.querySelectorAll('p, div, li, pre, blockquote, h1, h2, h3, h4, tr').forEach(node => node.append('\n'));
  return (clone.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
interface Message { element: Element; role: 'user' | 'assistant'; text: string }
export class DeepSeekAdapter implements SiteAdapter {
  readonly id = 'deepseek' as const;
  readonly name = 'DeepSeek';
  readonly capabilities = { capture: true, navigation: true, composer: true, selection: true, send: true };
  constructor(private readonly document: Document = window.document, private readonly url: () => string = () => window.location.href) {}
  detect(url: string): boolean {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'chat.deepseek.com'; } catch { return false; }
  }
  newConversationUrl(): string { return 'https://chat.deepseek.com/'; }
  private messages(): Message[] {
    const users = [...this.document.querySelectorAll(DEEPSEEK_SELECTORS.user)].filter(element => visible(element) && !element.querySelector('textarea, [contenteditable="true"]'));
    let assistants = [...this.document.querySelectorAll(DEEPSEEK_SELECTORS.assistant)].filter(visible);
    // Older DeepSeek markup: message-level markdown outside recognized user bubbles.
    if (assistants.length === 0) assistants = [...this.document.querySelectorAll('.ds-message')].filter(element => visible(element) && element.querySelector('.ds-markdown') && !users.some(user => element.contains(user) || user.contains(element)));
    const outermost = (nodes: Element[]) => nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
    return [...outermost(users).map(element => ({ element, role: 'user' as const })), ...outermost(assistants).map(element => ({ element, role: 'assistant' as const }))]
      .filter(message => !message.element.closest('[data-role="reasoning"], .ds-think-content, [class*="ds-think"]'))
      .map(message => {
        const finalContent = message.role === 'assistant' ? message.element.querySelector('.ds-assistant-message-main-content') ?? message.element : message.element;
        return { ...message, text: textContent(finalContent) };
      })
      .sort((a, b) => a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1);
  }
  private turns(): { turns: Turn[]; nodes: Map<string, Element>; messageCount: number } {
    const externalId = deepseekConversationId(this.url());
    if (!externalId) throw new Error('当前页面尚未生成对话地址，请先在 DeepSeek 中开始对话。');
    const messages = this.messages();
    const turns: Turn[] = [];
    const nodes = new Map<string, Element>();
    const occurrences = new Map<string, number>();
    for (const message of messages) {
      if (message.role === 'user' && message.text) {
        const hash = fingerprint(message.text);
        const occurrence = (occurrences.get(hash) ?? 0) + 1; occurrences.set(hash, occurrence);
        const carrier = message.element.closest('[data-message-id], [data-messageid], [data-msg-id], [data-virtual-list-item-key]');
        const messageId = carrier?.getAttribute('data-message-id') ?? carrier?.getAttribute('data-messageid') ?? carrier?.getAttribute('data-msg-id') ?? carrier?.getAttribute('data-virtual-list-item-key');
        const id = externalId + ':' + (messageId ? 'message:' + messageId : 'user:' + hash + ':' + occurrence);
        turns.push({ id, user: message.text, assistant: '', index: turns.length, fingerprint: hash });
        nodes.set(id, message.element);
      } else if (message.role === 'assistant' && turns.length && message.text) {
        const turn = turns[turns.length - 1]!;
        turn.assistant = [turn.assistant, message.text].filter(Boolean).join('\n\n');
      }
    }
    return { turns, nodes, messageCount: messages.length };
  }
  readSnapshot(): PageSnapshot {
    const externalId = deepseekConversationId(this.url());
    if (!externalId) throw new Error('当前页面尚未生成对话地址，请先在 DeepSeek 中开始对话。');
    const { turns, messageCount } = this.turns();
    if (!messageCount || !turns.length) throw new Error('未识别到可读取的对话。请等待页面加载；若仍失败，DeepSeek 页面结构可能已更新。');
    const parsed = new URL(this.url());
    // DeepSeek may virtualize older messages. DOM alone cannot prove completeness.
    const pageTitle = this.document.title.replace(/\s*[-|·]\s*DeepSeek.*$/i, '').trim();
    return { site: this.id, externalId, url: parsed.origin + parsed.pathname, title: !pageTitle || /^deepseek$/i.test(pageTitle) ? turns[0]!.user.slice(0, 60) : pageTitle, turns, complete: false };
  }
  locateTurn(turnId: string): boolean {
    let element: Element | undefined;
    try { element = this.turns().nodes.get(turnId); } catch { return false; }
    if (!element) return false;
    return locate(element as HTMLElement);
  }
  navigationAnchors() { const { turns, nodes } = this.turns(); return turns.map(t => ({ turnId: t.id, text: t.user, element: nodes.get(t.id)! as HTMLElement })); }
  private sendButton() {
    return buttonFor(this.document, 'button[data-testid="send-button"], [role="button"][aria-label="发送"], button[aria-label="发送"], button[aria-label="Send"], button[aria-label="Send message"], [role="button"][aria-label="Send"], [role="button"][aria-label="Send message"], button[aria-label="发送消息"], [role="button"][data-testid="send-button"], .ds-icon-button:has(svg path[d^="M8.3125 0.981"]), .ds-icon-button:has(svg path[d^="M8.3125 0.982"])', this.composer());
  }
  composerState(): 'ready' | 'generating' | 'unavailable' {
    if (candidates(this.document, '[aria-label="停止生成"], [aria-label="Stop generating"], [data-testid="stop-button"]').length) return 'generating';
    try { return this.sendButton() ? 'ready' : 'unavailable'; } catch { return 'unavailable'; }
  }
  submitComposer(expected: string) {
    if (normalizeText(this.readComposer()) !== normalizeText(expected)) throw new Error('输入内容已变化，请重新确认。');
    if (this.composerState() !== 'ready') throw new Error('发送按钮不可用，请等待回答结束或检查登录状态。');
    this.sendButton()!.click();
  }
  private composer(): HTMLTextAreaElement | HTMLElement {
    const elements = [...this.document.querySelectorAll<HTMLElement>(DEEPSEEK_SELECTORS.composer)].filter(visible);
    if (elements.length !== 1) throw new Error('无法唯一识别 DeepSeek 输入框。请等待页面加载，或复制预览内容后手动粘贴。');
    const element = elements[0]!;
    if (element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled') || element.hasAttribute('readonly')) throw new Error('输入框暂不可用，请等待当前回答结束。');
    return element;
  }
  readComposer(): string { const element = this.composer(); return element.tagName === 'TEXTAREA' ? (element as HTMLTextAreaElement).value : element.textContent ?? ''; }
  fillComposer(text: string, mode: 'append' | 'replace'): void {
    const element = this.composer();
    const existing = this.readComposer();
    const value = mode === 'append' && existing.trim() ? existing.trimEnd() + '\n\n' + text : text;
    const view = this.document.defaultView!;
    if (element.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) throw new Error('当前输入框不支持自动填入，请复制预览内容。');
      setter.call(element, value);
    } else { element.textContent = value; }
    element.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    element.focus();
    // No key events, submit events, send button clicks, or API calls.
  }
  readSelection(): SelectionSnapshot {
    const selection = this.document.getSelection();
    const result: SelectionSnapshot = { text: selection?.toString().trim() ?? '', title: this.document.title, url: this.url() };
    if (!result.text || !selection?.anchorNode) return result;
    try {
      const { nodes, turns } = this.turns();
      const anchor = selection.anchorNode.nodeType === 1 ? selection.anchorNode as Element : selection.anchorNode.parentElement;
      if (anchor) {
        const messages = this.messages();
        const containing = messages.find(message => message.element.contains(anchor));
        if (containing) {
          let current: string | undefined;
          for (const message of messages) {
            if (message.role === 'user') current = turns.find(turn => nodes.get(turn.id) === message.element)?.id;
            if (message === containing) { result.turnId = current; break; }
          }
        }
      }
    } catch { /* Selection works before a saved conversation exists. */ }
    return result;
  }
}
