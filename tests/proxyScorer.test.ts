import { describe, expect, it } from 'vitest';
import { scoreProxy } from '../src/proxy/ProxyScorer';
import { toProxyRecord } from '../src/proxy/ProxyParser';
import type { ProxyRecord } from '../src/shared/types/proxy';

function makeProxy(overrides: Partial<ProxyRecord> = {}): ProxyRecord {
  const p = toProxyRecord({ host: '1.2.3.4', port: 8080, protocol: 'http' }, 'test', {
    countryCode: 'US',
    countryVerified: true
  });
  p.status = 'working';
  p.latencyMs = 1000; // deliberately mid-range, not maxed out — otherwise the
  // 0-100 clamp can hide the Google-status adjustment entirely (a proxy
  // already scoring 100 on latency+reliability+country has nowhere left to
  // go up, and a small penalty on it may still stay well above 0).
  p.successCount = 4;
  p.failureCount = 1;
  return { ...p, ...overrides };
}

describe('scoreProxy — Google trust adjustment', () => {
  it('ranks a Google-trusted proxy above an otherwise identical unchecked one', () => {
    const unchecked = makeProxy({ googleStatus: 'unknown' });
    const trusted = makeProxy({ googleStatus: 'trusted' });

    expect(scoreProxy(trusted)).toBeGreaterThan(scoreProxy(unchecked));
  });

  it('ranks a Google-blocked proxy well below an otherwise identical unchecked one', () => {
    const unchecked = makeProxy({ googleStatus: 'unknown' });
    const blocked = makeProxy({ googleStatus: 'blocked' });

    expect(scoreProxy(blocked)).toBeLessThan(scoreProxy(unchecked));
  });

  it('never lets the Google penalty push the score below 0', () => {
    const blocked = makeProxy({ googleStatus: 'blocked', latencyMs: 4900, successCount: 1, failureCount: 9 });
    expect(scoreProxy(blocked)).toBeGreaterThanOrEqual(0);
  });

  it('still scores a dead proxy as 0 regardless of Google status', () => {
    const dead = makeProxy({ status: 'dead', googleStatus: 'trusted' });
    expect(scoreProxy(dead)).toBe(0);
  });
});
