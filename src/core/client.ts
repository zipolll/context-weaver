import { CHANNEL, type AppCommand, type Reply } from './types';
export async function request<T>(command: AppCommand): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ channel: CHANNEL, command });
  if (!reply) throw new Error('扩展连接已中断，请重新打开侧栏。');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
