/**
 * Core proxy domain types shared between main, preload and renderer.
 */

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

export type ProxyStatus = 'unknown' | 'checking' | 'working' | 'dead';

/** Whether a real Google Search request through this proxy came back clean
 * ('trusted') or hit Google's "unusual traffic" / CAPTCHA interstitial
 * ('blocked'). 'unknown' means it has never been checked against Google
 * specifically — a proxy can be network-'working' (responds, routes
 * traffic) while still being 'blocked' by Google, since that's a
 * reputation signal about the IP, not a connectivity one. */
export type GoogleTrustStatus = 'unknown' | 'trusted' | 'blocked';

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
  /** See GoogleTrustStatus. Only ever set by an explicit "Check Google
   * Trust" check (single or bulk) — plain reload/validate never touches it,
   * since that's a much heavier, slower request than a bare connectivity
   * check and shouldn't run on every proxy in a large imported list. */
  googleStatus: GoogleTrustStatus;
  /** When googleStatus was last set, ISO timestamp. */
  googleCheckedAt?: string;
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

export interface ReloadProgress {
  /** How many candidates have finished validating so far. */
  checked: number;
  /** Total candidates being validated this reload. */
  total: number;
}

/** Assignment of a validated proxy (or none) to a numbered browser workspace. */
export interface ProxyAssignment {
  browserId: number;
  proxy: ProxyRecord | null;
}

/** Result of (re-)validating every known (manually imported) proxy and
 * assigning the healthy ones to browsers. There is no fetch/discovery step
 * any more — proxies only enter the pool via Import Proxies — so this is
 * purely a validate-and-assign summary. */
export interface ReloadProxiesSummary {
  found: number;
  countryMatched: number;
  working: number;
  assignments: ProxyAssignment[];
}
