/**
 * Core proxy domain types shared between main, preload and renderer.
 */

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

export type ProxyStatus = 'unknown' | 'checking' | 'working' | 'dead';

export interface ProxyRecord {
  /** Stable id derived from protocol+host+port (see ProxyParser.buildId). */
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  /** Present only in memory / encrypted at rest — never logged. */
  username?: string;
  password?: string;
  /** ISO 3166-1 alpha-2 country code, when known. */
  countryCode?: string;
  /** Human readable country name, when known. */
  country?: string;
  /** True only when country metadata came from a source we trust. */
  countryVerified: boolean;
  /** Names of providers that returned this exact proxy. */
  sources: string[];
  lastChecked?: string;
  latencyMs?: number;
  status: ProxyStatus;
  /** 0-100 composite score used for ranking (see ProxyScorer). */
  score: number;
  /** Number of times this proxy has validated successfully, ever. */
  successCount: number;
  /** Number of times this proxy has failed validation, ever. */
  failureCount: number;
}

export interface ProxyImportResult {
  imported: number;
  valid: number;
  invalid: number;
  invalidLines: string[];
  proxies: ProxyRecord[];
}

export interface ProxyValidationResult {
  proxyId: string;
  status: ProxyStatus;
  latencyMs?: number;
  detectedCountryCode?: string;
  error?: string;
  checkedAt: string;
}

export interface ProxyProviderHealth {
  name: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  proxiesReturned: number;
  enabled: boolean;
}

export interface ProxyFetchOptions {
  countryCode?: string;
  signal?: AbortSignal;
}

export interface ProxyProvider {
  readonly name: string;
  readonly kind: 'public' | 'imported' | 'custom';
  fetchProxies(options: ProxyFetchOptions): Promise<ProxyRecord[]>;
}

/** Assignment of a validated proxy (or none) to a numbered browser workspace. */
export interface ProxyAssignment {
  browserId: number;
  proxy: ProxyRecord | null;
}

export interface ReloadProxiesSummary {
  found: number;
  countryMatched: number;
  working: number;
  assignments: ProxyAssignment[];
  providerErrors: Array<{ provider: string; reason: string }>;
}
