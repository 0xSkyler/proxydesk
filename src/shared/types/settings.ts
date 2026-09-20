import type { ProxyProtocol } from './proxy';

export type Theme = 'dark' | 'light' | 'system';
export type ProxyRotationInterval = 'off' | '10m' | '30m' | '60m' | 'manual';

export interface BrowserSettings {
  browserCount: number;
  /** Exact number of grid columns when gridSquareTiles is off — rows are
   * always just ceil(browserCount / gridColumns), so "2x3" is browserCount
   * 6 + gridColumns 2, "2x10" is browserCount 20 + gridColumns 2, etc. */
  gridColumns: number;
  /** When true, ignores gridColumns and instead lays out small, equal-sized
   * square tiles (mobile-icon-like) that auto-fill the available width. */
  gridSquareTiles: boolean;
  /** Minimum height (px) of each browser tile — the "screen size" of an
   * individual workspace in the grid. Higher = fewer tiles fit per row
   * before wrapping/scrolling; lower = more fit, but each is smaller. */
  tileMinHeight: number;
  persistSessions: boolean;
  startPage: string;
  userAgent: string;
  hardwareAcceleration: boolean;
  /** Periodically nudges every browser (a tiny, invisible scroll-and-back)
   * so sites don't treat the tab as idle and log the session out while
   * you're away from the app. */
  keepAliveEnabled: boolean;
  keepAliveIntervalSec: number;
  keepAliveFollowLinks: boolean;
  keepAliveMaxHops: number;
  seoMaxPages: number;
}

export interface ProxySettings {
  autoLoadOnStartup: boolean;
  /** When a browser hits Google's "unusual traffic" / CAPTCHA interstitial
   * while browsing normally (see BrowserManager.onGoogleBlocked /
   * main.ts's handleGoogleBlocked), turning this on marks that proxy
   * blocked, swaps in a different one, and retries the page the browser
   * was actually trying to reach — up to a small fixed number of times in
   * a row (see MAX_GOOGLE_BLOCK_RETRIES) before giving up and leaving it
   * for a manual "Change Proxy" click. */
  autoReplaceFailed: boolean;
  /** When true (default), every "Assign Proxies" click first makes a real
   * connectivity request through each candidate proxy to confirm it's
   * actually alive before assigning it. Turn this off if the imported list
   * was already checked before import (e.g. by whatever scraped/verified
   * it) — assignment then treats every non-dead proxy as immediately
   * eligible and skips straight to assigning, so a fresh import can be
   * assigned to browsers instantly instead of waiting through a second
   * connectivity pass. "Check Google Trust" is unaffected either way — it's
   * a separate, deliberately-manual check (see GoogleTrustChecker). */
  validationEnabled: boolean;
  validationTimeoutMs: number;
  allowProxyReuse: boolean;
  preferredProtocols: ProxyProtocol[];
  preferredCountryCode: string | null;
  autoRotationEnabled: boolean;
  rotationIntervalSec: number;
  /** @deprecated Legacy setting retained so older saved settings still load. */
  rotationInterval?: ProxyRotationInterval;
  ipCheckUrl: string;
  maxConcurrentChecks: number;
}

export interface PerformanceSettings {
  maxConcurrentProxyChecks: number;
  maxConcurrentPageLoads: number;
  suspendInactiveBrowsers: boolean;
}

export interface ApplicationSettings {
  startMinimized: boolean;
  startWithWindows: boolean;
  theme: Theme;
  notificationsEnabled: boolean;
  /** Main window size in pixels, applied when the window is created
   * (restart required to take effect on an already-open window). */
  windowWidth: number;
  windowHeight: number;
}

export interface AppSettings {
  browser: BrowserSettings;
  proxy: ProxySettings;
  performance: PerformanceSettings;
  application: ApplicationSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  browser: {
    browserCount: 10,
    gridColumns: 2,
    gridSquareTiles: false,
    tileMinHeight: 340,
    persistSessions: true,
    startPage: 'https://example.com',
    userAgent: '',
    hardwareAcceleration: true,
    keepAliveEnabled: false,
    keepAliveIntervalSec: 60,
    keepAliveFollowLinks: true,
    keepAliveMaxHops: 25,
    seoMaxPages: 5
  },
  proxy: {
    autoLoadOnStartup: true,
    autoReplaceFailed: true,
    validationEnabled: true,
    validationTimeoutMs: 6000,
    allowProxyReuse: false,
    preferredProtocols: ['http', 'https', 'socks4', 'socks5'],
    preferredCountryCode: null,
    autoRotationEnabled: false,
    rotationIntervalSec: 60,
    ipCheckUrl: 'https://api.ipify.org?format=json',
    maxConcurrentChecks: 25
  },
  performance: {
    maxConcurrentProxyChecks: 10,
    maxConcurrentPageLoads: 10,
    suspendInactiveBrowsers: false
  },
  application: {
    startMinimized: false,
    startWithWindows: false,
    theme: 'dark',
    notificationsEnabled: true,
    windowWidth: 1600,
    windowHeight: 1000
  }
};
