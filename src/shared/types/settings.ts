import type { ProxyProtocol } from './proxy';

export type GridLayout = '1x10' | '2x5' | '5x2';
export type Theme = 'dark' | 'light' | 'system';
export type ProxyRotationInterval = 'off' | '10m' | '30m' | '60m' | 'manual';

export interface BrowserSettings {
  browserCount: number;
  gridLayout: GridLayout;
  persistSessions: boolean;
  startPage: string;
  userAgent: string;
  hardwareAcceleration: boolean;
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
  publicProvidersEnabled: boolean;
  /** The monosans/proxy-scraper-checker-style aggregated public list source
   * (~70 GitHub/API lists). Off by default, same as publicProvidersEnabled:
   * untrusted sources, and gated behind the same warning acknowledgment. */
  aggregatedListsEnabled: boolean;
  maxConcurrentChecks: number;
  /** Hard cap on how many discovered proxies get validated in one reload.
   * Imported proxies and your own custom/API providers are never subject
   * to this cap — only public/aggregated-list results are, and a random
   * sample of them is taken so it isn't always the same subset. Without a
   * cap, enabling "Aggregated lists" (which can surface several thousand
   * proxies across ~70 sources) would queue all of them for validation at
   * maxConcurrentChecks concurrency — e.g. 5,000 candidates at 10
   * concurrent / 8s timeout each is ~66 minutes, which is what "reload
   * never finishes" usually means. */
  maxCandidatesPerReload: number;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  apiUrl: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  countryParam?: string;
  /** Dot-path to an array of proxy entries in the JSON response, e.g. "data.proxies" */
  responseArrayPath: string;
  enabled: boolean;
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
}

export interface AppSettings {
  browser: BrowserSettings;
  proxy: ProxySettings;
  customProviders: CustomProviderConfig[];
  performance: PerformanceSettings;
  application: ApplicationSettings;
  publicProxyWarningAcknowledged: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  browser: {
    browserCount: 10,
    gridLayout: '2x5',
    persistSessions: true,
    startPage: 'https://example.com',
    userAgent: '',
    hardwareAcceleration: true
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
    publicProvidersEnabled: false,
    aggregatedListsEnabled: false,
    maxConcurrentChecks: 25,
    maxCandidatesPerReload: 250
  },
  customProviders: [],
  performance: {
    maxConcurrentProxyChecks: 10,
    maxConcurrentPageLoads: 10,
    suspendInactiveBrowsers: false
  },
  application: {
    startMinimized: false,
    startWithWindows: false,
    theme: 'dark',
    notificationsEnabled: true
  },
  publicProxyWarningAcknowledged: false
};
