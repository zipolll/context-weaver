import { DeepSeekAdapter } from './deepseek';
import type { SiteAdapter } from './types';
export type { SiteAdapter, SiteCapabilities } from './types';
export { DeepSeekAdapter, deepseekConversationId } from './deepseek';
export function adapterFor(url: string, document: Document = window.document): SiteAdapter | null {
  const adapter = new DeepSeekAdapter(document, () => document.defaultView?.location.href ?? url);
  return adapter.detect(url) ? adapter : null;
}
