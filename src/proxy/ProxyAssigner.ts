import type { ProxyAssignment, ProxyRecord } from '../shared/types/proxy';
import { rankProxies } from './ProxyScorer';

export interface AssignOptions {
  browserIds: number[];
  allowProxyReuse: boolean;
  /** Existing assignments to prefer keeping stable when their proxy is still healthy. */
  currentAssignments?: Map<number, ProxyRecord | null>;
}

/**
 * Deterministic assignment algorithm:
 *  1. Candidates are assumed already filtered by country and deduped.
 *  2. Dead proxies are dropped.
 *  3. Remaining proxies are ranked by score (desc).
 *  4. Browsers that already have a still-healthy proxy keep it (minimizes disruption).
 *  5. Remaining browsers get the best unused proxy, preferring unique IPs.
 *  6. If proxies run out, browsers get `null` unless allowProxyReuse is set,
 *     in which case proxies are reused round-robin among the best candidates.
 */
export function assignProxies(candidates: ProxyRecord[], options: AssignOptions): ProxyAssignment[] {
  const healthy = candidates.filter((p) => p.status !== 'dead');
  const ranked = rankProxies(healthy);
  const usedIds = new Set<string>();
  const assignments: ProxyAssignment[] = [];
  const current = options.currentAssignments ?? new Map();

  const remainingBrowserIds: number[] = [];

  for (const browserId of options.browserIds) {
    const existing = current.get(browserId);
    if (existing && existing.status === 'working' && ranked.some((p) => p.id === existing.id)) {
      assignments.push({ browserId, proxy: existing });
      usedIds.add(existing.id);
    } else {
      remainingBrowserIds.push(browserId);
    }
  }

  const pool = ranked.filter((p) => !usedIds.has(p.id));
  let poolIndex = 0;

  for (const browserId of remainingBrowserIds) {
    if (poolIndex < pool.length) {
      const proxy = pool[poolIndex++];
      assignments.push({ browserId, proxy });
      usedIds.add(proxy.id);
      continue;
    }

    if (options.allowProxyReuse && ranked.length > 0) {
      const reuseProxy = ranked[(poolIndex - pool.length) % ranked.length];
      assignments.push({ browserId, proxy: reuseProxy });
      poolIndex++;
      continue;
    }

    assignments.push({ browserId, proxy: null });
  }

  // Restore original browser id ordering.
  const order = new Map(options.browserIds.map((id, idx) => [id, idx]));
  assignments.sort((a, b) => (order.get(a.browserId) ?? 0) - (order.get(b.browserId) ?? 0));

  return assignments;
}

export function filterByCountry(proxies: ProxyRecord[], countryCode: string | null): ProxyRecord[] {
  if (!countryCode) return proxies;
  const upper = countryCode.toUpperCase();
  return proxies.filter((p) => p.countryCode?.toUpperCase() === upper);
}
