import type { Action, Conversation, PromptTemplate, Snippet, SourceSnapshot } from './types';
import { turnHasId } from './turnLocation';
export const uid = () => crypto.randomUUID();
export const ACTION_LABELS: Record<Action, string> = { followup: '继续追问', explain: '解释概念', example: '举例说明', check: '检查论证' };
export function snapshotConversation(c: Conversation, throughTurnId?: string): SourceSnapshot {
  const end = throughTurnId ? c.turns.findIndex(t => turnHasId(t, throughTurnId)) : c.turns.length - 1;
  if (throughTurnId && end < 0) throw new Error('指定轮次已变化，请刷新后重试。');
  const turns = c.turns.slice(0, end + 1);
  return { id: uid(), conversationId: c.id, title: c.title, url: c.url, turnIds: turns.map(t => t.id), turns: structuredClone(turns), text: turns.map(t => '用户：' + t.user + '\n助手：' + t.assistant).join('\n\n'), capturedAt: Date.now() };
}
export function snapshotSnippet(s: Snippet): SourceSnapshot { return { id: uid(), conversationId: s.conversationId, title: s.title, url: s.url, turnIds: s.turnId ? [s.turnId] : [], text: s.text, capturedAt: s.createdAt }; }
export function renderPrompt(t: PromptTemplate, question: string, sources: SourceSnapshot[], action: Action): string {
  const values: Record<string, string> = { question: question.trim(), action: ACTION_LABELS[action], context: sources.map((s, i) => '[引用 ' + (i + 1) + '：' + s.title + ']\n' + s.text + '\n[/引用 ' + (i + 1) + ']').join('\n\n'), sources: sources.map((s, i) => '[' + (i + 1) + '] ' + s.title + ' ' + s.url).join('\n') };
  return t.body.replace(/\{\{(question|context|sources|action)\}\}/g, (_, name: string) => values[name] ?? '').trim();
}
