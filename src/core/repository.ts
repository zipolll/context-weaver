import { openDB } from 'idb';
import type { AppState } from './types';
import { createInitialState } from './state';
import { withWorkspace } from './workspace';
const database = () => openDB('context-weaver', 1, { upgrade(db) { if (!db.objectStoreNames.contains('state')) db.createObjectStore('state'); } });
let queue: Promise<unknown> = Promise.resolve();
export async function readState(): Promise<AppState> { const db = await database(); try { return withWorkspace((await db.get('state', 'current')) ?? createInitialState()); } finally { db.close(); } }
export function mutateState(fn: (state: AppState) => AppState): Promise<AppState> {
  const work = queue.then(async () => { const db = await database(); try { const tx = db.transaction('state', 'readwrite'); const next = fn(withWorkspace((await tx.store.get('current')) ?? createInitialState())); await tx.store.put(next, 'current'); await tx.done; return next; } catch (e) { if (e instanceof DOMException && e.name === 'QuotaExceededError') throw new Error('本地存储空间不足，请先导出备份并清理部分内容。'); throw e; } finally { db.close(); } });
  queue = work.catch(() => undefined); return work;
}
