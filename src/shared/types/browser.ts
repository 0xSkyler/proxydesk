import type { ProxyRecord } from './proxy';
import { MAX_BROWSER_COUNT } from '../constants';

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
  keepAliveEnabled: boolean;
  keepAliveHops: number;
  lastKeepAliveAt?: string;
  title?: string;
  faviconUrl?: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BroadcastSearchStatus = 'matched' | 'no-match' | 'paused' | 'monitoring' | 'error';

export interface BroadcastSearchResult {
  browserId: number;
  status: BroadcastSearchStatus;
  /** The URL the browser ended up on — the matched result's page when
   * status is 'matched', otherwise the Google results page itself. */
  landedUrl?: string;
  /** Title of the result that matched, when status is 'matched'. */
  matchedTitle?: string;
  /** Exact Google result destination detected during measurement. */
  matchedUrl?: string;
  /** True when this is a continuing observation rather than a terminal run. */
  monitoring?: boolean;
  /** How many organic results were scanned before finding a match (or not). */
  resultsScanned?: number;
  position?: number;
  resultPage?: number;
  keepAliveStarted?: boolean;
  error?: string;
  ranAt: string;
}

/** @deprecated kept only so nothing importing the old name breaks; the real
 * ceiling is MAX_BROWSER_COUNT (see shared/constants) and browser count is
 * now a user setting, not a fixed constant. */
export const BROWSER_COUNT = MAX_BROWSER_COUNT;

/** Every possible browser id, up to the maximum configurable count. Actual
 * rendering/creation always slices this down to `settings.browser.browserCount`
 * (see BrowserGrid.tsx and main.ts's getBrowserIds) — this array itself is
 * just the full id space, not "how many browsers exist right now". */
export const BROWSER_IDS: number[] = Array.from({ length: MAX_BROWSER_COUNT }, (_, i) => i + 1);
