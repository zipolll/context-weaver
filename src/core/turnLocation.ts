import { platformConversation } from '../adapters/platforms';
import type { Conversation, Turn, TurnLocation, TurnNavigationStatus } from './types';

export const turnText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
export const turnHasId = (turn: Turn, id: string) => turn.id === id || !!turn.aliases?.includes(id);
// Rendering may add invisible format marks; keep visible content and code whitespace intact.
export const questionText = (value: string) => turnText(value).replace(/[\u200b\u2060\ufeff]/g, '').normalize('NFC').trim();

function answerFingerprint(value: string): string | undefined {
  const text = questionText(value).replace(/\s+/g, ' '); if (text.length < 24) return undefined;
  let hash = 2166136261, second = 5381;
  for (const char of text) { hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619); second = Math.imul(second, 33) ^ char.codePointAt(0)!; }
  return `${text.length}:${hash >>> 0}:${second >>> 0}`;
}
type Description = Omit<TurnLocation, 'site' | 'externalId'>;

export function navigationFailure(status: Exclude<TurnNavigationStatus, 'found' | 'pending'>): string {
  if (status === 'ambiguous') return '已找到相同文字，但暂时无法确认具体是哪次提问。已停止自动查找，请加载相邻问答后重试。';
  if (status === 'wrong-page') return '页面已切换到其他对话，问题定位已停止。';
  return '未能定位到该提问，已停止自动查找。请确认原页的提问内容及历史加载情况后重试。';
}

export function describeTurn(turns: Turn[], turn: Turn): Description {
  const index = turns.indexOf(turn), user = questionText(turn.user), repeats = turns.filter(t => questionText(t.user) === user), answer = answerFingerprint(turn.assistant);
  return { user, index, total: turns.length, occurrence: repeats.indexOf(turn), occurrences: repeats.length,
    before: index ? questionText(turns[index - 1]!.user) : undefined, after: turns[index + 1] ? questionText(turns[index + 1]!.user) : undefined,
    ...(turn.aliases?.length ? { aliases: turn.aliases } : {}), ...(answer ? { answerFingerprint: answer, answerOccurrences: repeats.filter(t => answerFingerprint(t.assistant) === answer).length } : {}) };
}

export function createTurnLocation(conversation: Conversation, id: string): TurnLocation | undefined {
  const turn = conversation.turns.find(t => turnHasId(t, id));
  return turn ? { ...(platformConversation(conversation.url) ?? { site: conversation.site, externalId: conversation.externalId }), ...describeTurn(conversation.turns, turn) } : undefined;
}

/** Match actual question content, neighbours and occurrence, never an arbitrary text hit. */
export function findLocatedTurn(turns: Turn[], id: string, location?: Description): Turn | undefined {
  const direct = turns.find(turn => turnHasId(turn, id) || location?.aliases?.some(alias => turnHasId(turn, alias)));
  if (!location) return direct;
  const candidates = turns.filter(turn => questionText(turn.user) === questionText(location.user));
  // A complete, distinctive answer can identify a re-rendered question even when
  // legacy history contains an obsolete duplicate or its neighbours have changed.
  const answers = location.answerFingerprint && location.answerOccurrences === 1 ? candidates.filter(turn => answerFingerprint(turn.assistant) === location.answerFingerprint) : [];
  if (answers.length === 1) return answers[0];
  const directIndex = direct ? turns.indexOf(direct) : -1;
  const conflict = location.occurrences > 1 && (location.before !== undefined && directIndex > 0 && questionText(turns[directIndex - 1]!.user) !== questionText(location.before) || location.after !== undefined && directIndex + 1 < turns.length && directIndex >= 0 && questionText(turns[directIndex + 1]!.user) !== questionText(location.after));
  if (direct && !conflict && candidates.includes(direct) && (location.occurrences <= 1 || candidates.length !== location.occurrences || candidates.indexOf(direct) === location.occurrence)) return direct;
  if (candidates.length === 1 && location.occurrences === 1) return candidates[0];
  const ranked = candidates.map(turn => {
    const index = turns.indexOf(turn);
    return { turn, score: Number(location.before !== undefined && index > 0 && questionText(turns[index - 1]!.user) === questionText(location.before)) + Number(location.after !== undefined && index + 1 < turns.length && questionText(turns[index + 1]!.user) === questionText(location.after)) };
  }).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score && ranked[0].score > (ranked[1]?.score ?? 0)) return ranked[0].turn;
  if (candidates.length === location.occurrences) return candidates[location.occurrence];
  return undefined;
}
