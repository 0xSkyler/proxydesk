import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { ProxyRecord, ReloadProxiesSummary } from '../src/shared/types/proxy';
import type { BrowserManager } from '../src/main/BrowserManager';
import type { ProxyManager } from '../src/main/ProxyManager';
import type { SettingsManager } from '../src/main/SettingsManager';

const tempDirs: string[] = [];

function makeProxy(id: string): ProxyRecord {
  return {
    id,
    host: `${id}.example.test`,
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['test'],
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
      if (!state.cycleInProgress && state.cycleNumber > 0 && state.lastCycleCompletedAt) {
        manager.off('stateChanged', listener);
        resolve();
      }
    };
    manager.on('stateChanged', listener);
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('SeoAutomationManager', () => {
  it('starts SEO for a browser before the rest of proxy validation finishes and reuses the saved query', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxydesk-auto-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'proxy.txt');
    await fs.writeFile(filePath, '127.0.0.1:8000\n127.0.0.1:8001\n', 'utf8');

    const events: string[] = [];
    const searches: Array<{ id: number; query: string; target: string }> = [];
    const p1 = makeProxy('p1');
    const p2 = makeProxy('p2');

    const proxyManager = {
      cancelCurrentValidation() {
        events.push('cancel-validation');
      },
      resetAutomationRotationHistory() {
        events.push('reset-rotation-history');
      },
      async validateFileStreaming(
        _filePath: string,
        browserIds: number[],
        _country: string | null,
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }, checked: number, total: number) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number) => void
      ): Promise<ReloadProxiesSummary> {
        onProgress?.(0, 2, 0, 0);
        onAssignment({ browserId: browserIds[0], proxy: p1 }, 1, 2);
        onProgress?.(1, 2, 1, 1);

        // Give the assignment task a chance to apply the proxy and start
        // its SEO search while the second proxy is still "validating".
        await Promise.resolve();
        await Promise.resolve();
        events.push('validation-still-running');

        if (browserIds[1] != null) {
          onAssignment({ browserId: browserIds[1], proxy: p2 }, 2, 2);
          onProgress?.(2, 2, 2, 2);
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
      async broadcastSearch(id: number, query: string, target: string) {
        events.push(`search-${id}`);
        searches.push({ id, query, target });
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

    const settingsManager = {
      get() {
        return {
          proxy: { preferredCountryCode: null },
          browser: { seoMaxPages: 5 }
        };
      }
    } as unknown as SettingsManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserManager,
      settingsManager,
      () => [1, 2]
    );

    await manager.start({
      sourceFilePath: filePath,
      query: 'saved keyword',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserIds: [1, 2]
    });
    await waitForCycle(manager);

    expect(events).toContain('reset-rotation-history');
    expect(events.indexOf('assign-1')).toBeGreaterThan(-1);
    expect(events.indexOf('search-1')).toBeGreaterThan(events.indexOf('assign-1'));
    expect(events.indexOf('search-1')).toBeLessThan(events.indexOf('validation-finished'));
    expect(searches.every((item) => item.query === 'saved keyword')).toBe(true);
    expect(searches.every((item) => item.target === 'example.com')).toBe(true);

    const firstSearchCount = searches.length;
    await manager.runNow();
    await waitForCycle(manager);
    expect(searches.length).toBeGreaterThan(firstSearchCount);
    expect(searches.slice(firstSearchCount).every((item) => item.query === 'saved keyword')).toBe(true);

    manager.stop();
    expect(manager.getState().running).toBe(false);
  });
});
