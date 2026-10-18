import type { PageSnapshot, SelectionSnapshot } from '../core/types';
import type { PlatformId } from './platforms';
export interface SiteCapabilities { capture: boolean; navigation: boolean; composer: boolean; selection: boolean; send: boolean }
export interface NavigationAnchor { turnId: string; text: string; element: HTMLElement }
export type ComposerState = 'ready' | 'generating' | 'unavailable';
export interface SiteAdapter {
  readonly id: PlatformId;
  readonly name: string;
  readonly capabilities: SiteCapabilities;
  detect(url: string): boolean;
  readSnapshot(): PageSnapshot;
  navigationAnchors(): NavigationAnchor[];
  locateTurn(turnId: string): boolean;
  readComposer(): string;
  fillComposer(text: string, mode: 'append' | 'replace'): void;
  composerState(): ComposerState;
  submitComposer(expectedText: string): void;
  readSelection(): SelectionSnapshot;
  newConversationUrl(): string;
}
