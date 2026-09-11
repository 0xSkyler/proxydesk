import type { ProxyRecord } from './proxy';

export type BrowserConnectionStatus =
  | 'idle'
  | 'loading'
  | 'connected'
  | 'proxy-checking'
  | 'proxy-failed'
  | 'no-proxy'
  | 'crashed';

export interface BrowserState {
  id: number;
  label: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  proxy: ProxyRecord | null;
  connectionStatus: BrowserConnectionStatus;
  detectedIp?: string;
  lastIpCheckAt?: string;
  errorMessage?: string;
  crashCount: number;
  title?: string;
  faviconUrl?: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BroadcastSearchStatus = 'matched' | 'no-match' | 'blocked' | 'error';

export interface BroadcastSearchResult {
  browserId: number;
  status: BroadcastSearchStatus;
  /** The URL the browser ended up on — the matched result's page when
   * status is 'matched', otherwise the Google results page itself. */
  landedUrl?: string;
  /** Title of the result that matched, when status is 'matched'. */
  matchedTitle?: string;
  /** How many organic results were scanned before finding a match (or not). */
  resultsScanned?: number;
  error?: string;
  ranAt: string;
}

export const BROWSER_COUNT = 10;

export const BROWSER_IDS: number[] = Array.from({ length: BROWSER_COUNT }, (_, i) => i + 1);
