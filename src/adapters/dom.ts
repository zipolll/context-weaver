export const normalizeText = (text: string) => text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
export function visible(node: Element): boolean {
  if (node.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let current: Element | null = node; current; current = current.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}
export function disabled(node: Element) { return node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('readonly'); }
export function candidates(doc: Document, selector: string) { return [...doc.querySelectorAll<HTMLElement>(selector)].filter(visible); }
export function uniqueComposer(doc: Document, selector: string): HTMLElement {
  const nodes = candidates(doc, selector);
  if (nodes.length !== 1 || disabled(nodes[0]!)) throw new Error('输入框不可用，请确认已登录并等待当前回答结束。');
  return nodes[0]!;
}
export function readInput(node: HTMLElement) { return node.tagName === 'TEXTAREA' ? (node as HTMLTextAreaElement).value : node.innerText ?? node.textContent ?? ''; }
export function fillInput(node: HTMLElement, text: string, mode: 'append' | 'replace') {
  const doc = node.ownerDocument, view = doc.defaultView!;
  const old = readInput(node); const value = mode === 'append' && old.trim() ? old.trimEnd() + '\n\n' + text : text;
  node.focus();
  if (node.tagName === 'TEXTAREA') Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value);
  else {
    // Let ProseMirror/Quill handle the browser editing transaction when available.
    const selection = doc.getSelection(), range = doc.createRange(); range.selectNodeContents(node); selection?.removeAllRanges(); selection?.addRange(range);
    if (!doc.execCommand?.('insertText', false, value)) {
      node.replaceChildren();
      value.split('\n').forEach(line => { const p = doc.createElement('p'); if (line) p.textContent = line; else p.append(doc.createElement('br')); node.append(p); });
    }
  }
  node.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  node.dispatchEvent(new view.Event('change', { bubbles: true }));
}
export function buttonFor(doc: Document, selector: string, composer: HTMLElement): HTMLElement | undefined {
  let nodes = candidates(doc, selector).filter(node => !disabled(node));
  const form = composer.closest('form'); if (form && nodes.some(node => form.contains(node))) nodes = nodes.filter(node => form.contains(node));
  return nodes.length === 1 ? nodes[0] : undefined;
}
export function cleanText(node: Element) {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('button, script, style, [hidden], [aria-hidden="true"], [data-role="reasoning"], .thoughts-container, model-thoughts, .thinking-content, details').forEach(n => n.remove());
  copy.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
  copy.querySelectorAll('p, div, li, pre, h1, h2, h3').forEach(n => n.append('\n'));
  return normalizeText(copy.textContent ?? '').replace(/\n{3,}/g, '\n\n');
}
export function fingerprint(text: string) { let hash = 2166136261; for (const char of text.replace(/\s+/g, ' ').trim()) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
export function locate(node?: HTMLElement) { if (!node) return false; const reduced = node.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; node.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' }); const old = node.style.outline; node.style.outline = '2px solid #4563FF'; setTimeout(() => { node.style.outline = old; }, 1400); return true; }
