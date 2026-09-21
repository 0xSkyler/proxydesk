import { describe, expect, it } from 'vitest';
import {
  PROXYSCRAPE_FREE_API,
  buildProxyScrapeFreeListUrl
} from '../src/proxy/ProxyScrapeProvider';

describe('ProxyScrape free API source', () => {
  it('builds a direct public API request with protocol-qualified text output', () => {
    const url = buildProxyScrapeFreeListUrl({ limit: 2500, timeoutFilterMs: 6000 });

    expect(url.origin + url.pathname).toBe(PROXYSCRAPE_FREE_API);
    expect(url.searchParams.get('request')).toBe('display_proxies');
    expect(url.searchParams.get('protocol')).toBe('all');
    expect(url.searchParams.get('proxy_format')).toBe('protocolipport');
    expect(url.searchParams.get('format')).toBe('text');
    expect(url.searchParams.get('timeout')).toBe('6000');
    expect(url.searchParams.get('limit')).toBe('2000');
  });
});
