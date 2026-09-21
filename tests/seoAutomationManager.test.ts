import { describe, expect, it } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { ProxyRecord, ReloadProxiesSummary } from '../src/shared/types/proxy';
import type { BrowserManager } from '../src/main/BrowserManager';
import type { ProxyManager } from '../src/main/ProxyManager';

function makeProxy(id: string): ProxyRecord {
  return {
    id,
    host: `${id}.example.test`,
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['ProxyScrape Free API'],
    status: 'working',
    score: 100,
    successCount: 1,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

async function waitForCycle(manager: SeoAutomationManager): Promise<void> {
  if (!manager.getState().cycleInProgress && manager.getState().cycleNumber > 0) return;
  await new Promise<void>((resolve) => {
    const listener = (state: ReturnType<SeoAutomationManager['getState']>) => {
      if (!state.cycleInProgress && state.lastCycleCompletedAt) {
        manager.off('stateChanged', listener);
        resolve();
      }
    };
    manager.on('stateChanged', listener);
  });
}

describe('SeoAutomationManager Lite workflow', () => {
  it('starts SEO immediately when individual live proxies arrive and reuses the saved job on rotation', async () => {
    const events: string[] = [];
    const searches: Array<{ id: number; query: string; target: string; maxPages: number }> = [];
    const p1 = makeProxy('p1');
    const p2 = makeProxy('p2');

    const proxyManager = {
      cancelCurrentValidation() {
        events.push('cancel');
      },
      resetRotationHistory() {
        events.push('reset-history');
      },
      async fetchValidateAssignStreaming(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
      ): Promise<ReloadProxiesSummary> {
        onProgress?.(0, 2, 0, 0, 2);
        onAssignment({ browserId: browserIds[0], proxy: p1 });
        onProgress?.(1, 2, 1, 1, 2);

        await Promise.resolve();
        await Promise.resolve();
        events.push('validation-still-running');

        if (browserIds[1] != null) {
          onAssignment({ browserId: browserIds[1], proxy: p2 });
          onProgress?.(2, 2, 2, 2, 2);
        }
        events.push('validation-finished');

        return {
          found: 2,
          countryMatched: 2,
          working: 2,
          assignments: browserIds.map((browserId, index) => ({
            browserId,
            proxy: index === 0 ? p1 : p2
          }))
        };
      }
    } as unknown as ProxyManager;

    const browserManager = {
      async assignProxy(id: number, proxy: ProxyRecord | null) {
        events.push(proxy ? `assign-${id}` : `direct-${id}`);
      },
      async broadcastSearch(id: number, query: string, target: string, maxPages: number) {
        events.push(`search-${id}`);
        searches.push({ id, query, target, maxPages });
        return {
          browserId: id,
          status: 'matched' as const,
          landedUrl: `https://${target}/article`,
          keepAliveStarted: true,
          ranAt: new Date().toISOString()
        };
      },
      setBrowserKeepAlive(id: number, enabled: boolean) {
        events.push(`keepalive-${id}-${enabled ? 'on' : 'off'}`);
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserManager,
      async (count) => Array.from({ length: count }, (_, index) => index + 1)
    );

    await manager.start({
      query: 'saved keyword',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 2,
      maxPages: 37
    });
    await waitForCycle(manager);

    expect(events).toContain('reset-history');
    expect(events.indexOf('search-1')).toBeGreaterThan(events.indexOf('assign-1'));
    expect(events.indexOf('search-1')).toBeLessThan(events.indexOf('validation-finished'));
    expect(searches.every((search) => search.query === 'saved keyword')).toBe(true);
    expect(searches.every((search) => search.target === 'example.com')).toBe(true);
    expect(searches.every((search) => search.maxPages === 37)).toBe(true);

    const firstSearchCount = searches.length;
    await manager.runNow();
    await waitForCycle(manager);
    expect(searches.length).toBeGreaterThan(firstSearchCount);
    expect(searches.slice(firstSearchCount).every((search) => search.query === 'saved keyword')).toBe(true);

    manager.stop();
    expect(manager.getState().running).toBe(false);
  });
});
