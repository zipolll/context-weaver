import type { AppState, NodeRef, TagEntry } from './types';

const PALETTE = ['#8070c7', '#368e84', '#c48049', '#537eb9', '#b15d87', '#819241', '#ba635c', '#508eab', '#986da4', '#a1843c', '#4d916b', '#6d78ad'];
export const isTagColor = (color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

// Names without entries occur in older backups. Stable IDs also survive read-only
// normalization before the first database write.
function legacyTagId(name: string): string {
  let a = 2166136261, b = 5381;
  for (const char of name) { a = Math.imul(a ^ char.codePointAt(0)!, 16777619); b = Math.imul(b, 33) ^ char.codePointAt(0)!; }
  return 'legacy-tag-' + (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16);
}
function nextColor(used: Set<string>): string {
  const available = PALETTE.find(color => !used.has(color)); if (available) return available;
  for (let index = 0; ; index++) {
    const hue = (index * 137.508 + 19) % 360 / 60, saturation = 0.43 + index % 3 * 0.06, lightness = 0.44 + index % 4 * 0.035;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, x = chroma * (1 - Math.abs(hue % 2 - 1)), m = lightness - chroma / 2;
    const rgb = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
    const color = '#' + rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('');
    if (!used.has(color)) return color;
  }
}
export function normalizeTags(state: AppState): void {
  let entries = state.tagEntries ??= [];
  const metadata = [...state.conversations, ...state.questionMeta ?? []];
  for (const name of new Set(metadata.flatMap(node => node.tags))) {
    if (entries.some(tag => tag.kind === 'tag' && tag.name === name)) continue;
    const base = legacyTagId(name); let id = base, suffix = 0;
    while (entries.some(tag => tag.id === id)) id = base + '-' + ++suffix;
    entries.push({ id, name, kind: 'tag', parentId: null });
  }
  // Independent backups can contain the same named Tag under different IDs.
  // Keep the existing entry and redirect primary references to that identity.
  const names = new Map<string, string>(), redirects = new Map<string, string>();
  entries = state.tagEntries = entries.filter(tag => {
    if (tag.kind !== 'tag') return true;
    const existing = names.get(tag.name);
    if (existing) { redirects.set(tag.id, existing); return false; }
    names.set(tag.name, tag.id); return true;
  });
  for (const node of metadata) if (node.primaryTagId && redirects.has(node.primaryTagId)) node.primaryTagId = redirects.get(node.primaryTagId);
  const used = new Set<string>();
  for (const tag of entries) {
    if (tag.kind === 'folder') { delete tag.color; continue; }
    if (isTagColor(tag.color) && !used.has(tag.color.toLowerCase())) { tag.color = tag.color.toLowerCase(); used.add(tag.color); }
    else delete tag.color;
  }
  for (const tag of entries) if (tag.kind === 'tag' && !tag.color) { tag.color = nextColor(used); used.add(tag.color); }
  const byName = new Map(entries.filter(tag => tag.kind === 'tag').map(tag => [tag.name, tag]));
  for (const node of metadata) {
    const selected = node.tags.map(name => byName.get(name)).filter((tag): tag is TagEntry => !!tag);
    const primary = selected.find(tag => tag.id === node.primaryTagId) ?? selected[0];
    if (primary) node.primaryTagId = primary.id; else delete node.primaryTagId;
  }
}
export function primaryTag(state: AppState, ref: NodeRef): TagEntry | undefined {
  const node = ref.turnId ? state.questionMeta?.find(q => q.conversationId === ref.conversationId && q.turnId === ref.turnId) : state.conversations.find(c => c.id === ref.conversationId);
  return state.tagEntries?.find(tag => tag.kind === 'tag' && tag.id === node?.primaryTagId && node.tags.includes(tag.name));
}
