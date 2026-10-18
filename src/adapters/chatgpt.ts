import { StructuredAdapter } from './structured';
export class ChatGPTAdapter extends StructuredAdapter {
  constructor(doc: Document = window.document, url: () => string = () => window.location.href) { super({ id:'chatgpt', user:'[data-message-author-role="user"]', assistant:'[data-message-author-role="assistant"]', composer:'#prompt-textarea[contenteditable="true"], textarea#prompt-textarea', send:'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"]', stop:'button[data-testid="stop-button"], button[aria-label="Stop streaming"]', conversationId: u => /\/(?:c)\/([a-zA-Z0-9_-]+)\/?$/.exec(u.pathname)?.[1] ?? null },doc,url); }
}
