import type { PlatformId } from '../adapters/platforms';
export type ID = string;
export interface Container { id: ID; kind: 'project' | 'folder'; name: string; parentId: ID | null; order: number; createdAt: number }
export interface Turn { id: ID; user: string; assistant: string; index: number; fingerprint: string; question?: string }
export interface Conversation { id: ID; site: string; externalId: string; url: string; title: string; sourceTitle?: string; customTitle: boolean; containerId: ID | null; tags: string[]; starred: boolean; archived: boolean; turns: Turn[]; complete: boolean; createdAt: number; updatedAt: number }
export interface SourceSnapshot { id: ID; conversationId: ID | null; title: string; url: string; turnIds: ID[]; text: string; capturedAt: number; turns?: Turn[] }
export interface Relation { id: ID; targetId: ID; source: SourceSnapshot; createdAt: number }
export interface Snippet { id: ID; text: string; title: string; url: string; conversationId: ID | null; turnId: ID | null; createdAt: number }
export type Action = 'followup' | 'explain' | 'example' | 'check';
export interface PromptTemplate { id: ID; name: string; body: string; action: Action }
export interface Draft { graphId?: ID; openMode?: OpenMode; id: ID; sources: SourceSnapshot[]; editedSources?: SourceSnapshot[]; question: string; action: Action; templateId: ID; prompt: string; destination: 'current' | 'new'; targetSite?: PlatformId; tabId?: number; status: 'preview' | 'waiting' | 'filled' | 'submitting' | 'sent' | 'uncertain' | 'bound' | 'failed'; createdAt: number; error?: string; sentTurnId?: string; targetExternalId?: string }
export interface NodeRef { conversationId: ID; turnId?: ID }
export interface KnowledgeGraph { id: ID; name: string; folderId: ID | null; conversationIds: ID[]; positions: Record<string, { x: number; y: number }>; expanded: ID[]; createdAt: number; updatedAt: number }
export interface TagEntry { id: ID; name: string; kind: 'folder' | 'tag'; parentId: ID | null }
export interface QuestionMeta extends NodeRef { turnId: ID; tags: string[] }
export interface StagedItem { id: ID; source: SourceSnapshot; node?: NodeRef; selected: boolean; createdAt: number }
export type OpenMode = 'split' | 'tab';
export interface AppState { version: 1; containers: Container[]; conversations: Conversation[]; relations: Relation[]; snippets: Snippet[]; drafts: Draft[]; templates: PromptTemplate[]; graphs?: KnowledgeGraph[]; activeGraphId?: ID; tagEntries?: TagEntry[]; questionMeta?: QuestionMeta[]; staged?: StagedItem[]; openMode?: OpenMode }
export interface ApiSettings { endpoint: string; model: string; apiKey: string }
export interface PageSnapshot { site: string; externalId: string; url: string; title: string; sourceTitle?: string; turns: Turn[]; complete: boolean }
export interface SelectionSnapshot { text: string; title: string; url: string; turnId?: string }
export interface ActivePage { tabId: number; url: string; title: string; supported: boolean; site?: PlatformId; snapshot?: PageSnapshot; selection?: SelectionSnapshot }
export interface UiIntent { action: Action | 'stage'; destination: 'current' | 'new'; selection: SelectionSnapshot; tabId: number; nonce: string }
export type AppCommand =
  | { type: 'state.get' }
  | { type: 'graph.save'; graph: KnowledgeGraph }
  | { type: 'graph.activate'; id: ID }
  | { type: 'graph.patch'; id: ID; patch: Partial<Pick<KnowledgeGraph, 'name' | 'folderId' | 'expanded' | 'positions' | 'conversationIds'>> }
  | { type: 'graph.delete'; id: ID }
  | { type: 'graph.add'; id: ID; conversationIds: ID[] }
  | { type: 'node.tags'; node: NodeRef; tags: string[] }
  | { type: 'tag.save'; tag: TagEntry }
  | { type: 'tag.delete'; id: ID }
  | { type: 'tag.merge'; fromId: ID; intoId: ID }
  | { type: 'stage.save'; item: StagedItem }
  | { type: 'stage.delete'; id: ID }
  | { type: 'openMode.save'; mode: OpenMode }
  | { type: 'container.save'; container: Container }
  | { type: 'container.delete'; id: ID }
  | { type: 'conversation.capture'; tabId?: number; containerId?: ID | null }
  | { type: 'conversation.patch'; id: ID; patch: Partial<Pick<Conversation, 'title' | 'containerId' | 'tags' | 'starred' | 'archived'>> }
  | { type: 'conversation.delete'; id: ID }
  | { type: 'snippet.save'; snippet: Snippet }
  | { type: 'snippet.delete'; id: ID }
  | { type: 'template.save'; template: PromptTemplate }
  | { type: 'draft.save'; draft: Draft }
  | { type: 'draft.send'; id: ID; mode?: 'replace' | 'append'; tabId?: number; expectedComposer?: string }
  | { type: 'page.active' }
  | { type: 'page.locate'; tabId?: number; turnId: ID }
  | { type: 'page.composer'; tabId?: number }
  | { type: 'page.open'; url: string; turnId?: ID; mode?: OpenMode }
  | { type: 'platform.last' }
  | { type: 'settings.get' }
  | { type: 'settings.save'; settings: ApiSettings }
  | { type: 'backup.export' }
  | { type: 'backup.import'; data: unknown }
  | { type: 'data.clear' }
  | { type: 'intent.get' }
  | { type: 'intent.claim' }
  | { type: 'intent.clear'; nonce: string };
export interface SendResult { status: 'sent' | 'uncertain' | 'failed'; snapshot?: PageSnapshot; turnId?: string; error?: string }
export type ContentCommand =
  | { type: 'cw.snapshot' }
  | { type: 'cw.labels'; labels: Record<string,string> }
  | { type: 'cw.locate'; turnId: ID }
  | { type: 'cw.composer' }
  | { type: 'cw.fill'; text: string; mode: 'replace' | 'append' }
  | { type: 'cw.send'; requestId: string; text: string; expectedComposer: string }
  | { type: 'cw.selection' };
export type ContentEvent = { type: 'cw.updated'; snapshot: PageSnapshot } | { type: 'cw.selection.changed'; selection: SelectionSnapshot };
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
export const CHANNEL = 'context-weaver';
