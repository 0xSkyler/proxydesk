export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';
export type ProxyFilter = 'all' | ProxyProtocol;
export type BrowserRunStatus = 'idle' | 'proxy' | 'searching' | 'matched' | 'not-found' | 'blocked' | 'error';

export interface ProxyEndpoint {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  id: number;
  label: string;
  url: string;
  loading: boolean;
  status: BrowserRunStatus;
  currentPage: number;
  proxy: ProxyEndpoint | null;
  message?: string;
}

export interface TrackerConfig {
  query: string;
  target: string;
  maxPages: number;
  browserCount: number;
  proxyFilter: ProxyFilter;
}

export interface TrackerResult {
  browserId: number;
  status: Exclude<BrowserRunStatus, 'idle' | 'proxy' | 'searching'>;
  proxy: ProxyEndpoint | null;
  page?: number;
  position?: number;
  matchedUrl?: string;
  title?: string;
  error?: string;
  finishedAt: string;
}

export interface TrackerState {
  running: boolean;
  proxiesFetched: number;
  browserCount: number;
  startedAt?: string;
  results: TrackerResult[];
}

export interface ProxyFetchSummary {
  fetched: number;
  protocols: Record<ProxyProtocol, number>;
  fetchedAt: string;
}
