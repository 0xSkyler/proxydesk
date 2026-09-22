import { describe, expect, it } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { ProxyRecord, ReloadProxiesSummary } from '../src/shared/types/proxy';
import type { BroadcastSearchResult } from '../src/shared/types/browser';
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

describe('SeoAutomationManager continuous measurement', () => {
  it('starts monitoring as soon as a live proxy is assigned without waiting for validation to finish', async () => {
    const events: string[] = [];
    const searches: Array<{ id: number; query: string; target: string; maxPages: number }> = [];
    const tokens = new Map<number, number>();
    const proxy = makeProxy('p1');

    const proxyManager = {
      cancelCurrentValidation() {
        events.push('cancel-validation');
      },
      resetRotationHistory() {
        events.push('reset-history');
      },
      async fetchValidateAssignStreaming(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
      ): Promise<ReloadProxiesSummary> {
        onProgress?.(0, 1, 0, 0, 1);
        onAssignment({ browserId: browserIds[0], proxy });
        onProgress?.(1, 1, 1, 1, 1);
        await Promise.resolve();
        await Promise.resolve();
        events.push('validation-finished');
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: [{ browserId: browserIds[0], proxy }]
        };
      }
    } as unknown as ProxyManager;

    const browserManager = {
      async assignProxy(id: number, assignedProxy: ProxyRecord | null) {
        events.push(assignedProxy ? `assign-${id}` : `direct-${id}`);
      },
      setBrowserKeepAlive(id: number, enabled: boolean) {
        events.push(`keepalive-${id}-${enabled ? 'on' : 'off'}`);
      },
      cancelMeasurementSession(id: number) {
        tokens.set(id, (tokens.get(id) ?? 0) + 1);
        events.push(`cancel-monitor-${id}`);
      },
      startMeasurementSession(id: number) {
        const token = (tokens.get(id) ?? 0) + 1;
        tokens.set(id, token);
        events.push(`start-monitor-${id}`);
        return token;
      },
      isMeasurementSessionCurrent(id: number, token: number) {
        return tokens.get(id) === token;
      },
      async broadcastSearch(
        id: number,
        query: string,
        target: string,
        maxPages: number
      ): Promise<BroadcastSearchResult> {
        events.push(`search-${id}`);
        searches.push({ id, query, target, maxPages });
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=saved+keyword',
          matchedUrl: `https://${target}/article`,
          matchedTitle: 'Detected article',
          monitoring: true,
          ranAt: new Date().toISOString()
        };
      },
      async waitForGoogleRecovery() {
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserManager,
      async () => [1]
    );

    const observed = new Promise<BroadcastSearchResult>((resolve) => {
      manager.on('seoResult', ({ result }) => resolve(result));
    });

    await manager.start({
      query: 'saved keyword',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 37
    });
    await waitForCycle(manager);
    const result = await observed;

    expect(events).toContain('reset-history');
    expect(events.indexOf('search-1')).toBeGreaterThan(events.indexOf('assign-1'));
    expect(events.indexOf('search-1')).toBeLessThan(events.indexOf('validation-finished'));
    expect(searches[0]).toEqual({
      id: 1,
      query: 'saved keyword',
      target: 'example.com',
      maxPages: 37
    });
    expect(result.status).toBe('matched');
    expect(result.matchedUrl).toBe('https://example.com/article');

    manager.stop();
    expect(manager.getState().running).toBe(false);
  });

  it('treats a Google challenge as paused and resumes the saved measurement after recovery', async () => {
    const proxy = makeProxy('p2');
    const tokens = new Map<number, number>();
    const statuses: string[] = [];
    let searchCount = 0;
    let recoveryCount = 0;

    const proxyManager = {
      cancelCurrentValidation() {},
      resetRotationHistory() {},
      async fetchValidateAssignStreaming(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void
      ): Promise<ReloadProxiesSummary> {
        onAssignment({ browserId: browserIds[0], proxy });
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: [{ browserId: browserIds[0], proxy }]
        };
      }
    } as unknown as ProxyManager;

    const browserManager = {
      async assignProxy() {},
      setBrowserKeepAlive() {},
      cancelMeasurementSession(id: number) {
        tokens.set(id, (tokens.get(id) ?? 0) + 1);
      },
      startMeasurementSession(id: number) {
        const token = (tokens.get(id) ?? 0) + 1;
        tokens.set(id, token);
        return token;
      },
      isMeasurementSessionCurrent(id: number, token: number) {
        return tokens.get(id) === token;
      },
      async broadcastSearch(
        id: number,
        _query: string,
        _target: string,
        _maxPages: number
      ): Promise<BroadcastSearchResult> {
        searchCount += 1;
        if (searchCount === 1) {
          return {
            browserId: id,
            status: 'paused',
            landedUrl: 'https://www.google.com/sorry/index',
            monitoring: true,
            ranAt: new Date().toISOString()
          };
        }
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=rmg+cutting',
          matchedUrl: 'https://appareldiary.com/article/rmg-cutting',
          matchedTitle: 'RMG Cutting Process',
          monitoring: true,
          ranAt: new Date().toISOString()
        };
      },
      async waitForGoogleRecovery() {
        recoveryCount += 1;
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);

    const completed = new Promise<void>((resolve) => {
      manager.on('seoResult', ({ result }) => {
        statuses.push(result.status);
        if (result.status === 'matched') resolve();
      });
    });

    await manager.start({
      query: 'rmg cutting',
      targetWebsite: 'appareldiary.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    await completed;

    expect(statuses.slice(0, 2)).toEqual(['paused', 'matched']);
    expect(recoveryCount).toBe(1);
    expect(searchCount).toBe(2);

    manager.stop();
  });
});
