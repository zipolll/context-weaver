export type PlatformId = 'deepseek' | 'chatgpt' | 'gemini';
export const PLATFORMS = [
  { id: 'deepseek', name: 'DeepSeek', origin: 'https://chat.deepseek.com', newUrl: 'https://chat.deepseek.com/' },
  { id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com', newUrl: 'https://chatgpt.com/' },
  { id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com', newUrl: 'https://gemini.google.com/app' },
] as const;
export const PLATFORM_MATCHES = PLATFORMS.map(p => p.origin + '/*');
export function platformFor(url = '') { try { return PLATFORMS.find(p => p.origin === new URL(url).origin); } catch { return undefined; } }
export function platformName(id: string) { return PLATFORMS.find(p => p.id === id)?.name ?? id; }
export function platformById(id?: string) { return PLATFORMS.find(p => p.id === id) ?? PLATFORMS[0]; }

/** A conversation keeps its identity across URL variants and legacy site/ID formats. */
export function platformConversation(value: string): { site: PlatformId; externalId: string } | null {
  const platform = platformFor(value); if (!platform) return null;
  const url = new URL(value);
  const pattern = platform.id === 'deepseek' ? /^\/a\/chat\/(?:s\/)?([A-Za-z0-9_-]+)\/?$/ : platform.id === 'chatgpt' ? /\/c\/([A-Za-z0-9_-]+)\/?$/ : /^\/app\/([A-Za-z0-9_-]+)\/?$/;
  const externalId = pattern.exec(url.pathname)?.[1];
  if (!externalId || platform.id === 'deepseek' && ['new', 's', 'history', 'settings', 'login'].includes(externalId.toLowerCase())) return null;
  return { site: platform.id, externalId };
}

export function conversationIdentity(value: { site: string; externalId: string; url: string }): string {
  const identity = platformConversation(value.url) ?? value;
  return JSON.stringify([identity.site, identity.externalId]);
}
