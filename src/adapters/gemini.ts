import { StructuredAdapter } from './structured';
export class GeminiAdapter extends StructuredAdapter {
  constructor(doc: Document = window.document, url: () => string = () => window.location.href) { super({ id:'gemini', user:'user-query .query-text, user-query [data-test-id="user-query"], [data-test-id="user-query"]', assistant:'model-response message-content, model-response .markdown-main-panel', composer:'rich-textarea .ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"][role="textbox"]', send:'button.send-button, button[aria-label="Send message"], button[aria-label="发送消息"]', stop:'button[aria-label="Stop response"], button[aria-label="停止回答"], button.stop-button', conversationId: u => /^\/app\/([a-zA-Z0-9_-]+)\/?$/.exec(u.pathname)?.[1] ?? null },doc,url); }
}
