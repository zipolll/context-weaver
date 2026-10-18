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
