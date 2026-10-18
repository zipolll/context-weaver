import type { PageSnapshot, SelectionSnapshot, Turn } from '../core/types';
import type { SiteAdapter, ComposerState } from './types';
import { platformById, platformFor, type PlatformId } from './platforms';
import { buttonFor, candidates, cleanText, fillInput, fingerprint, locate, normalizeText, readInput, uniqueComposer } from './dom';
export interface DomConfig { id: PlatformId; user: string; assistant: string; composer: string; send: string; stop: string; conversationId: (url: URL) => string | null }
export class StructuredAdapter implements SiteAdapter {
  readonly capabilities = { capture: true, navigation: true, composer: true, selection: true, send: true };
  get id() { return this.config.id; } get name() { return platformById(this.id).name; }
  constructor(private config: DomConfig, private document: Document = window.document, private url: () => string = () => window.location.href) {}
  detect(url: string) { return platformFor(url)?.id === this.id; }
  newConversationUrl() { return platformById(this.id).newUrl; }
  private messages() {
    const nodes = [...candidates(this.document, this.config.user).map(element => ({ element, role: 'user' as const })), ...candidates(this.document, this.config.assistant).map(element => ({ element, role: 'assistant' as const }))];
    return nodes.filter(n => !nodes.some(other => other !== n && other.role === n.role && other.element.contains(n.element))).sort((a,b) => a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1);
  }
  private read() {
    const externalId = this.config.conversationId(new URL(this.url()));
    if (!externalId) throw new Error('请先发送一条消息，等待对话地址生成。');
    const turns: Turn[] = [], nodes = new Map<string, HTMLElement>(); const occurrences = new Map<string, number>();
    for (const {element, role} of this.messages()) {
      const text = cleanText(element); if (!text) continue;
      if (role === 'user') {
        const hash = fingerprint(text), occurrence = (occurrences.get(hash) ?? 0) + 1; occurrences.set(hash, occurrence);
        const carrier = element.closest('[data-message-id], [data-turn-id], [data-messageid], [id^="user-query"]');
        const stableId = carrier?.getAttribute('data-message-id') ?? carrier?.getAttribute('data-turn-id') ?? carrier?.getAttribute('data-messageid') ?? carrier?.id;
        const id = externalId + ':' + (stableId ? 'message:' + stableId : 'user:' + hash + ':' + occurrence);
        turns.push({ id, user: text, assistant: '', index: turns.length, fingerprint: hash }); nodes.set(id, element);
      } else if (turns.length) turns[turns.length - 1]!.assistant += (turns[turns.length - 1]!.assistant ? '\n\n' : '') + text;
    }
    if (!turns.length) throw new Error('未识别到对话，请等待加载或刷新页面。');
    return { externalId, turns, nodes };
  }
  readSnapshot(): PageSnapshot { const {externalId, turns} = this.read(); const url = new URL(this.url()); return { site: this.id, externalId, url: url.origin + url.pathname, title: turns[0]!.user.slice(0,60), turns, complete: false }; }
  navigationAnchors() { const {turns,nodes} = this.read(); return turns.map(t => ({ turnId:t.id,text:t.user,element:nodes.get(t.id)! })); }
  locateTurn(id: string) { try { return locate(this.read().nodes.get(id)); } catch { return false; } }
  private composer() { return uniqueComposer(this.document, this.config.composer); }
  readComposer() { return readInput(this.composer()); }
  fillComposer(text: string, mode: 'append'|'replace') { fillInput(this.composer(),text,mode); }
  composerState(): ComposerState { if (candidates(this.document,this.config.stop).length) return 'generating'; try { return buttonFor(this.document,this.config.send,this.composer()) ? 'ready' : 'unavailable'; } catch { return 'unavailable'; } }
  submitComposer(expected: string) { if (normalizeText(this.readComposer()) !== normalizeText(expected)) throw new Error('输入内容已变化，请重新确认。'); if (this.composerState() !== 'ready') throw new Error('发送按钮不可用，请等待当前回答结束或检查登录状态。'); buttonFor(this.document,this.config.send,this.composer())!.click(); }
  readSelection(): SelectionSnapshot { const selection = this.document.getSelection(); const result: SelectionSnapshot = { text: selection?.toString().trim() ?? '', title: this.document.title, url: this.url() }; try { let turnId: string | undefined; const {nodes} = this.read(); for (const message of this.messages()) { if (message.role === 'user') turnId = [...nodes].find(([,node])=>node===message.element)?.[0]; if (selection?.anchorNode && message.element.contains(selection.anchorNode)) { result.turnId=turnId; break; } } } catch {} return result; }
}
