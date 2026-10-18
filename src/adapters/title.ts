/** Prefer the active conversation's sidebar label, retaining full text in storage. */
export function conversationTitle(document: Document, url: string, fallback: string): string {
  const current = new URL(url);
  const links = [...document.querySelectorAll<HTMLElement>('a[href], [data-href], [aria-current="page"]')];
  const matching = links.filter(element => {
    const href = element.getAttribute('href') ?? element.getAttribute('data-href');
    if (!href) return element.getAttribute('aria-current') === 'page' && !!element.closest('nav, aside, [role="navigation"]');
    try { const target = new URL(href, current); return target.origin === current.origin && target.pathname.replace(/\/$/, '') === current.pathname.replace(/\/$/, ''); } catch { return false; }
  }).sort((a,b) => Number(!!b.closest('nav, aside, [role="navigation"]')) - Number(!!a.closest('nav, aside, [role="navigation"]')));
  // Some sidebar history items (notably Gemini) are buttons rather than links.
  const active = [...document.querySelectorAll<HTMLElement>('.conversation.selected, [data-test-id="conversation"].selected, nav [aria-selected="true"], aside [aria-selected="true"], [role="navigation"] [aria-selected="true"]')];
  for (const element of [...matching, ...active]) {
    const label = element.querySelector<HTMLElement>('[data-testid="conversation-title"], .conversation-title, [class*="chat-title"], [class*="conversation-title"]');
    const copy = (label ?? element).cloneNode(true) as HTMLElement;
    copy.querySelectorAll('button, svg, [aria-hidden="true"], [role="menu"], [hidden]').forEach(node => node.remove());
    const title = (label?.getAttribute('title') || copy.textContent || element.getAttribute('title') || '').replace(/\s+/g,' ').trim();
    if (title) return title;
  }
  const title = document.title.replace(/\s*[-|·–—]\s*(DeepSeek|ChatGPT|Google Gemini|Gemini).*$/i, '').trim();
  return title && !/^(DeepSeek|ChatGPT|Google Gemini|Gemini)$/i.test(title) ? title : fallback;
}
