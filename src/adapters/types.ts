import type { PageSnapshot, SelectionSnapshot } from '../core/types';
export interface SiteCapabilities { capture: boolean; navigation: boolean; composer: boolean; selection: boolean }
export interface SiteAdapter {
  readonly id: string;
  readonly capabilities: SiteCapabilities;
  detect(url: string): boolean;
  readSnapshot(): PageSnapshot;
  locateTurn(turnId: string): boolean;
  readComposer(): string;
  fillComposer(text: string, mode: 'append' | 'replace'): void;
  readSelection(): SelectionSnapshot;
  newConversationUrl(): string;
}
