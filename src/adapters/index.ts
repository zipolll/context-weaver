import { DeepSeekAdapter } from './deepseek';
import { ChatGPTAdapter } from './chatgpt';
import { GeminiAdapter } from './gemini';
import type { SiteAdapter } from './types';
export type { SiteAdapter, SiteCapabilities } from './types';
export { DeepSeekAdapter, deepseekConversationId } from './deepseek';
export { ChatGPTAdapter } from './chatgpt';
export { GeminiAdapter } from './gemini';
export function adapterFor(url: string, document: Document = window.document): SiteAdapter | null {
  const currentUrl = () => document.defaultView?.location.href.startsWith('https:') ? document.defaultView.location.href : url;
  return [new DeepSeekAdapter(document,currentUrl),new ChatGPTAdapter(document,currentUrl),new GeminiAdapter(document,currentUrl)].find(adapter => adapter.detect(url)) ?? null;
}
