import { describe, expect, it } from 'vitest';
import { assignProxies } from '../src/proxy/ProxyAssigner';
import type { ProxyRecord } from '../src/shared/types/proxy';

function makeProxy(id: string, score: number, host: string): ProxyRecord {
  return {
    id,
    host,
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['test'],
    status: 'working',
    score,
    successCount: 1,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

describe('rotation-aware proxy assignment', () => {
  const pool = [
    makeProxy('a', 100, '10.0.1.1'),
    makeProxy('b', 90, '10.0.2.1'),
    makeProxy('c', 80, '10.0.3.1')
  ];

  it('can deliberately move away from stable existing assignments', () => {
    const current = new Map<number, ProxyRecord | null>([
      [1, pool[0]],
      [2, pool[1]]
    ]);

    const rotated = assignProxies(pool, {
      browserIds: [1, 2],
      allowProxyReuse: false,
      currentAssignments: current,
      keepExisting: false,
      startOffset: 1
    });

    expect(rotated[0].proxy?.id).toBe('b');
    expect(rotated[1].proxy?.id).toBe('c');
  });

  it('does not duplicate a proxy in one cycle when reuse is disabled', () => {
    const rotated = assignProxies(pool, {
      browserIds: [1, 2, 3],
      allowProxyReuse: false,
      keepExisting: false,
      startOffset: 2
    });
    const ids = rotated.map((item) => item.proxy?.id).filter((id): id is string => Boolean(id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
