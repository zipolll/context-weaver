import type { Turn } from './types';
import { describeTurn, findLocatedTurn, questionText, turnHasId } from './turnLocation';

export function matchTurnHistory(previous: Turn[], incoming: Turn[]): Map<string, Turn> {
  const matches = new Map<string, Turn>(), used = new Set<string>();
  // Reserve exact IDs first, so a genuinely repeated new question remains separate.
  for (const turn of incoming) {
    const old = previous.find(candidate => turnHasId(candidate, turn.id) && !used.has(candidate.id) && questionText(candidate.user) === questionText(turn.user));
    if (old) { matches.set(turn.id, old); used.add(old.id); }
  }
  for (const old of previous) {
    if (used.has(old.id)) continue;
    const turn = findLocatedTurn(incoming, old.id, describeTurn(previous, old));
    if (!turn || matches.has(turn.id)) continue;
    const a = questionText(old.assistant), b = questionText(turn.assistant);
    if (a && b && !a.startsWith(b) && !b.startsWith(a)) continue;
    if (a && !b && !old.id.includes(':user:') && !turn.id.includes(':user:')) continue;
    matches.set(turn.id, old); used.add(old.id);
  }
  return matches;
}

/** Partial page reads update known turns without discarding unloaded history. */
export function mergeTurnHistory(previous: Turn[], incoming: Turn[]): Turn[] {
  const matches = matchTurnHistory(previous, incoming);
  const claimed = new Set([...matches.values()].map(turn => turn.id));
  // During hydration the new DOM may contain questions before their answers.
  // Wait for evidence before adding an apparent repeat with a replacement ID.
  incoming = incoming.filter(turn => matches.has(turn.id) || !!questionText(turn.assistant) || !previous.some(old => !claimed.has(old.id) && !!questionText(old.assistant) && questionText(old.user) === questionText(turn.user)));
  incoming = incoming.map(turn => {
    const old = matches.get(turn.id);
    if (!old) return turn;
    const aliases = [...new Set([...(old.aliases ?? []), ...(turn.aliases ?? []), ...(old.id === turn.id ? [] : [turn.id])])].filter(id => id !== old.id).slice(-32);
    return { ...turn, id: old.id, ...(aliases.length ? { aliases } : {}) };
  });
  const records = new Map(previous.map(t => [t.id, t])), order = previous.map(t => t.id);
  incoming.forEach((turn, i) => {
    const old = records.get(turn.id);
    records.set(turn.id, { ...turn, ...(turn.question || old?.question ? { question: turn.question || old?.question } : {}), assistant: turn.assistant || old?.assistant || '' });
    if (order.includes(turn.id)) return;
    const before = incoming.slice(i + 1).find(t => order.includes(t.id)), after = incoming.slice(0, i).reverse().find(t => order.includes(t.id));
    if (before) order.splice(order.indexOf(before.id), 0, turn.id);
    else if (after) order.splice(order.indexOf(after.id) + 1, 0, turn.id);
    else order.push(turn.id);
  });
  return order.map((id, index) => ({ ...records.get(id)!, index }));
}
