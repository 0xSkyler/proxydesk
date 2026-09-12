import { describe, expect, it } from 'vitest';
import { assignProxies, filterByCountry } from '../src/proxy/ProxyAssigner';
import { toProxyRecord } from '../src/proxy/ProxyParser';
import { scoreProxy } from '../src/proxy/ProxyScorer';
import type { ProxyRecord } from '../src/shared/types/proxy';

function makeWorkingProxy(host: string, latencyMs: number, countryCode = 'US'): ProxyRecord {
  const p = toProxyRecord({ host, port: 8080, protocol: 'http' }, 'test', {
    countryCode,
    countryVerified: true
  });
  p.status = 'working';
  p.latencyMs = latencyMs;
  p.successCount = 5;
  p.failureCount = 0;
  p.score = scoreProxy(p);
  return p;
}

describe('filterByCountry', () => {
  it('returns everything when no country is selected', () => {
    const proxies = [makeWorkingProxy('1.1.1.1', 100, 'US'), makeWorkingProxy('2.2.2.2', 100, 'GB')];
    expect(filterByCountry(proxies, null)).toHaveLength(2);
  });

  it('filters by country code case-insensitively', () => {
    const proxies = [makeWorkingProxy('1.1.1.1', 100, 'US'), makeWorkingProxy('2.2.2.2', 100, 'GB')];
    expect(filterByCountry(proxies, 'us')).toHaveLength(1);
  });
});

describe('assignProxies', () => {
  it('assigns 10 unique proxies to 10 browsers when 10+ are available', () => {
    const proxies = Array.from({ length: 12 }, (_, i) => makeWorkingProxy(`10.0.0.${i}`, 100 + i * 10));
    const browserIds = Array.from({ length: 10 }, (_, i) => i + 1);

    const assignments = assignProxies(proxies, { browserIds, allowProxyReuse: false });

    expect(assignments).toHaveLength(10);
    expect(assignments.every((a) => a.proxy !== null)).toBe(true);
    const uniqueIps = new Set(assignments.map((a) => a.proxy!.host));
    expect(uniqueIps.size).toBe(10);
  });

  it('assigns what it can and leaves the rest unassigned when only 6 proxies exist for 10 browsers', () => {
    const proxies = Array.from({ length: 6 }, (_, i) => makeWorkingProxy(`10.0.0.${i}`, 100));
    const browserIds = Array.from({ length: 10 }, (_, i) => i + 1);

    const assignments = assignProxies(proxies, { browserIds, allowProxyReuse: false });

    const assigned = assignments.filter((a) => a.proxy !== null);
    const unassigned = assignments.filter((a) => a.proxy === null);
    expect(assigned).toHaveLength(6);
    expect(unassigned).toHaveLength(4);
  });

  it('assigns nothing when zero proxies are available', () => {
    const browserIds = Array.from({ length: 10 }, (_, i) => i + 1);
    const assignments = assignProxies([], { browserIds, allowProxyReuse: false });
    expect(assignments.every((a) => a.proxy === null)).toBe(true);
  });

  it('reuses proxies round-robin only when allowProxyReuse is true', () => {
    const proxies = [makeWorkingProxy('10.0.0.1', 100), makeWorkingProxy('10.0.0.2', 100)];
    const browserIds = [1, 2, 3, 4];

    const withoutReuse = assignProxies(proxies, { browserIds, allowProxyReuse: false });
    expect(withoutReuse.filter((a) => a.proxy === null)).toHaveLength(2);

    const withReuse = assignProxies(proxies, { browserIds, allowProxyReuse: true });
    expect(withReuse.every((a) => a.proxy !== null)).toBe(true);
  });

  it('drops dead proxies from candidates before assigning', () => {
    const working = makeWorkingProxy('10.0.0.1', 100);
    const dead = makeWorkingProxy('10.0.0.2', 100);
    dead.status = 'dead';

    const assignments = assignProxies([working, dead], { browserIds: [1, 2], allowProxyReuse: false });
    const assigned = assignments.filter((a) => a.proxy !== null);
    expect(assigned).toHaveLength(1);
    expect(assigned[0].proxy!.host).toBe('10.0.0.1');
  });

  it('keeps a browser on its current healthy proxy rather than churning it on reload', () => {
    const keep = makeWorkingProxy('10.0.0.1', 500);
    const better = makeWorkingProxy('10.0.0.2', 50);
    const currentAssignments = new Map([[1, keep]]);

    const assignments = assignProxies([keep, better], {
      browserIds: [1, 2],
      allowProxyReuse: false,
      currentAssignments
    });

    expect(assignments.find((a) => a.browserId === 1)?.proxy?.host).toBe('10.0.0.1');
  });

  it('preserves the original browser id ordering in the result', () => {
    const proxies = [makeWorkingProxy('10.0.0.1', 100)];
    const assignments = assignProxies(proxies, { browserIds: [5, 3, 1, 2, 4], allowProxyReuse: false });
    expect(assignments.map((a) => a.browserId)).toEqual([5, 3, 1, 2, 4]);
  });

  it('prefers spreading assignments across different /24 subnets over always taking the top few by score', () => {
    // Two proxies in 10.0.0.x rank higher than the rest, but assigning both
    // of them plus nothing else would put half the browsers on one subnet.
    const proxies = [
      makeWorkingProxy('10.0.0.1', 10),
      makeWorkingProxy('10.0.0.2', 20),
      makeWorkingProxy('20.0.0.1', 30),
      makeWorkingProxy('30.0.0.1', 40)
    ];
    const assignments = assignProxies(proxies, { browserIds: [1, 2, 3], allowProxyReuse: false });
    const hosts = assignments.map((a) => a.proxy!.host);
    const subnets = new Set(hosts.map((h) => h.split('.').slice(0, 3).join('.')));
    // 3 browsers, 3 distinct subnets available — diversity should win over
    // picking the two best-ranked 10.0.0.x proxies plus one more.
    expect(subnets.size).toBe(3);
  });

  it('falls back to a repeated subnet rather than leaving a browser unassigned', () => {
    const proxies = [makeWorkingProxy('10.0.0.1', 10), makeWorkingProxy('10.0.0.2', 20)];
    const assignments = assignProxies(proxies, { browserIds: [1, 2], allowProxyReuse: false });
    expect(assignments.every((a) => a.proxy !== null)).toBe(true);
  });
});

describe('scoreProxy', () => {
  it('scores a dead proxy as 0', () => {
    const p = makeWorkingProxy('10.0.0.1', 100);
    p.status = 'dead';
    expect(scoreProxy(p)).toBe(0);
  });

  it('scores low latency + high reliability higher than high latency + low reliability', () => {
    const fast = makeWorkingProxy('10.0.0.1', 50);
    fast.successCount = 10;
    fast.failureCount = 0;
    fast.score = scoreProxy(fast);

    const slow = makeWorkingProxy('10.0.0.2', 4000);
    slow.successCount = 1;
    slow.failureCount = 9;
    slow.score = scoreProxy(slow);

    expect(fast.score).toBeGreaterThan(slow.score);
  });
});
