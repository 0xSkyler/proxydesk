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
 *  5. Remaining browsers get the best unused proxy, preferring both unique
 *     IPs and — among equally-ranked candidates — a /24 subnet that isn't
 *     already assigned to another browser (a proxy for real ASN/network
 *     diversity would need a paid IP-intelligence lookup; the /24 prefix
 *     is the practical approximation available with nothing but the
 *     proxy's own IP). This avoids all 10 browsers quietly landing on the
 *     same datacenter block even when the pool has more variety available
 *     but ranked slightly lower on latency/reliability alone.
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
  const usedSubnets = new Set<string>();

  for (const browserId of options.browserIds) {
    const existing = current.get(browserId);
    if (existing && existing.status === 'working' && ranked.some((p) => p.id === existing.id)) {
      assignments.push({ browserId, proxy: existing });
      usedIds.add(existing.id);
      const subnet = subnetOf(existing.host);
      if (subnet) usedSubnets.add(subnet);
    } else {
      remainingBrowserIds.push(browserId);
    }
  }

  const pool = preferSubnetDiversity(
    ranked.filter((p) => !usedIds.has(p.id)),
    usedSubnets,
    remainingBrowserIds.length
  );
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

/** First three octets of an IPv4 host, as a stand-in for "same network" —
 * returns null for a hostname-based proxy (rare in these lists), which is
 * treated as always diverse since there's nothing to compare it against. */
function subnetOf(host: string): string | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  return parts.slice(0, 3).join('.');
}

/**
 * Reorders `pool` (already rank-sorted, best first) so that the first
 * `slotsNeeded` entries prefer distinct /24 subnets over raw rank — taking
 * the single best-ranked proxy from each new subnet before taking a
 * second proxy from one already picked. Proxies whose subnet doesn't fit
 * in that diverse first pass are appended afterward in their original
 * rank order, so nothing is dropped and ties still favor the better score.
 */
function preferSubnetDiversity(pool: ProxyRecord[], alreadyUsedSubnets: Set<string>, slotsNeeded: number): ProxyRecord[] {
  if (slotsNeeded <= 0) return pool;

  const seen = new Set(alreadyUsedSubnets);
  const diverse: ProxyRecord[] = [];
  const rest: ProxyRecord[] = [];

  for (const proxy of pool) {
    const subnet = subnetOf(proxy.host);
    if (diverse.length < slotsNeeded && (!subnet || !seen.has(subnet))) {
      diverse.push(proxy);
      if (subnet) seen.add(subnet);
    } else {
      rest.push(proxy);
    }
  }

  return [...diverse, ...rest];
}
