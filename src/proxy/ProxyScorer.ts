import type { ProxyRecord } from '../shared/types/proxy';

/**
 * Composite 0-100 quality score used for ranking.
 * Score = latency component + reliability component + verified-country bonus.
 */
export function scoreProxy(proxy: ProxyRecord): number {
  if (proxy.status === 'dead') return 0;

  const latencyScore = latencyComponent(proxy.latencyMs);
  const reliabilityScore = reliabilityComponent(proxy.successCount, proxy.failureCount);
  const countryBonus = proxy.countryVerified ? 10 : 0;

  const raw = latencyScore * 0.5 + reliabilityScore * 0.4 + countryBonus;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function latencyComponent(latencyMs?: number): number {
  if (latencyMs == null) return 40; // unknown latency: neutral-ish score
  if (latencyMs <= 200) return 100;
  if (latencyMs >= 5000) return 0;
  // Linear falloff between 200ms (100) and 5000ms (0).
  return Math.round(100 - ((latencyMs - 200) / (5000 - 200)) * 100);
}

function reliabilityComponent(successCount: number, failureCount: number): number {
  const total = successCount + failureCount;
  if (total === 0) return 50; // never tested: neutral
  return Math.round((successCount / total) * 100);
}

export function rankProxies(proxies: ProxyRecord[]): ProxyRecord[] {
  return [...proxies].sort((a, b) => b.score - a.score);
}
