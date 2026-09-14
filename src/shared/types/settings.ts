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
}

export interface ProxySettings {
  autoLoadOnStartup: boolean;
  autoReplaceFailed: boolean;
  validationEnabled: boolean;
  validationTimeoutMs: number;
  allowProxyReuse: boolean;
  preferredProtocols: ProxyProtocol[];
  preferredCountryCode: string | null;
  rotationInterval: ProxyRotationInterval;
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
    keepAliveIntervalSec: 60
  },
  proxy: {
    autoLoadOnStartup: true,
    autoReplaceFailed: true,
    validationEnabled: true,
    validationTimeoutMs: 6000,
    allowProxyReuse: false,
    preferredProtocols: ['http', 'https', 'socks4', 'socks5'],
    preferredCountryCode: null,
    rotationInterval: 'manual',
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
