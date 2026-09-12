import type { ProxyProtocol } from './proxy';

export type GridLayout = '1x10' | '2x5' | '5x2' | 'square';
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
    notificationsEnabled: true
  }
};
