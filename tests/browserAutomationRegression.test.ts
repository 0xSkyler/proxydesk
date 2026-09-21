import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserView: class {},
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  session: { fromPartition: vi.fn() }
}));

import { BrowserManager, buildGoogleResultScanScript } from '../src/main/BrowserManager';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('browser automation regressions', () => {
  it('arms and executes Keep Alive from the individual browser control', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({ links: [] });
    const webContents = {
      getURL: () => 'https://appareldiary.com/article/test',
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript
    };
    const managed = {
      id: 1,
      view: { webContents },
      session: {},
      state: { id: 1, keepAliveEnabled: false, keepAliveHops: 0 },
      restartAttempts: 0,
      googleBlockRetries: 0,
      keepAliveEnabled: false,
      keepAliveHops: 0,
      keepAliveNextAt: 0,
      keepAliveBusy: false,
      keepAliveVisited: new Set<string>()
    };

    const manager = new BrowserManager();
    const internals = manager as unknown as {
      browsers: Map<number, unknown>;
      tickKeepAlive(): void;
      keepAliveTimer: NodeJS.Timeout | null;
    };
    internals.browsers.set(1, managed);

    manager.setBrowserKeepAlive(1, true, true);

    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledTimes(1));
    expect(managed.keepAliveEnabled).toBe(false);
    expect(internals.keepAliveTimer).not.toBeNull();

    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });

  it('detects and clicks a Google result before loadURL finishes', async () => {
    const targetUrl = 'https://appareldiary.com/article/safety-stock';
    let currentUrl = 'about:blank';

    const loadURL = vi.fn().mockImplementation((url: string) => {
      // Simulate Chromium committing/painting Google immediately while the
      // navigation promise itself is still waiting on slow resources.
      currentUrl = url;
      return new Promise<void>(() => undefined);
    });

    const executeJavaScript = vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('resultsScanned')) {
        return {
          blocked: false,
          ready: true,
          resultsScanned: 1,
          match: { url: targetUrl, title: 'Safety Stock Article', organicIndex: 0 }
        };
      }
      if (script.includes('anchor.click()')) {
        currentUrl = targetUrl;
        return true;
      }
      return { links: [] };
    });

    const webContents = {
      loadURL,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript
    };
    const managed = {
      id: 1,
      view: { webContents },
      session: {},
      state: { id: 1, keepAliveEnabled: false, keepAliveHops: 0, loading: true },
      restartAttempts: 0,
      googleBlockRetries: 0,
      keepAliveEnabled: false,
      keepAliveHops: 0,
      keepAliveNextAt: 0,
      keepAliveBusy: false,
      keepAliveVisited: new Set<string>()
    };

    const manager = new BrowserManager();
    const internals = manager as unknown as {
      browsers: Map<number, unknown>;
      keepAliveTimer: NodeJS.Timeout | null;
    };
    internals.browsers.set(1, managed);

    const result = await Promise.race([
      manager.broadcastSearch(1, 'safety stock', 'appareldiary.com', 1),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('SEO scanner waited for full page load')), 500)
      )
    ]);

    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('matched');
    expect(result.landedUrl).toBe(targetUrl);
    expect(result.keepAliveStarted).toBe(true);
    expect(executeJavaScript).toHaveBeenCalled();

    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });
  it('uses a native WebContents mouse click when the target result exposes coordinates', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'https://www.google.com/search?q=rmg+cutting';
    const sent: Array<{ type: string; x?: number; y?: number }> = [];

    const webContents = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript: vi.fn().mockResolvedValue({
        blocked: false,
        ready: true,
        resultsScanned: 1,
        match: {
          url: targetUrl,
          title: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
          organicIndex: 0,
          clickPoint: { x: 260, y: 315 }
        }
      }),
      sendInputEvent: vi.fn().mockImplementation((event: { type: string; x?: number; y?: number }) => {
        sent.push(event);
        if (event.type === 'mouseUp') currentUrl = targetUrl;
      })
    };

    const managed = {
      id: 11,
      view: { webContents },
      session: {},
      state: { id: 11, keepAliveEnabled: false, keepAliveHops: 0, loading: true },
      restartAttempts: 0,
      googleBlockRetries: 0,
      keepAliveEnabled: false,
      keepAliveHops: 0,
      keepAliveNextAt: 0,
      keepAliveBusy: false,
      keepAliveVisited: new Set<string>()
    };

    const manager = new BrowserManager();
    const internals = manager as unknown as {
      browsers: Map<number, unknown>;
      keepAliveTimer: NodeJS.Timeout | null;
    };
    internals.browsers.set(11, managed);

    const result = await manager.broadcastSearch(11, 'rmg cutting', 'appareldiary.com', 1);

    expect(result.status).toBe('matched');
    expect(sent.map((event) => event.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp']);
    expect(webContents.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mouseDown', x: 260, y: 315 })
    );

    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });
  it('finds a screenshot-like result when the domain label is a sibling of the blue title link', () => {
    const targetUrl = 'https://appareldiary.com/article/precision-and-profit-rmg-cutting';
    const rect = { left: 65, top: 285, width: 520, height: 34, right: 585, bottom: 319 };
    const titleAnchor = {
      href: targetUrl,
      innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
      getAttribute: (name: string) => (name === 'href' ? targetUrl : null),
      querySelector: () => null,
      closest: (selector: string) => (selector.includes('MjjYud') ? resultCard : null),
      parentElement: null,
      getBoundingClientRect: () => rect,
      scrollIntoView: vi.fn()
    };
    const domainNode = {
      innerText: 'appareldiary.com',
      parentElement: null,
      closest: (selector: string) => {
        if (selector === 'a[href]') return null;
        if (selector.includes('MjjYud')) return resultCard;
        return null;
      }
    };
    const resultCard = {
      innerText: 'appareldiary.com\nhttps://appareldiary.com › article › precision-and-profit-a...\nRMG Cutting Process: A Stage-by-Stage Control Guide',
      parentElement: null,
      querySelector: (selector: string) => (selector === 'a[href]' ? titleAnchor : null),
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? [titleAnchor] : []),
      closest: () => null
    };
    const searchRoot = {
      querySelectorAll: (selector: string) => {
        if (selector === 'a[href]') return [titleAnchor];
        if (selector === 'span, cite, div') return [domainNode];
        return [];
      }
    };
    const document = {
      body: { innerText: 'Google Search results' },
      readyState: 'interactive',
      querySelector: (selector: string) => (selector === '#search' ? searchRoot : null)
    };
    const location = { href: 'https://www.google.com/search?q=rmg+cutting' };

    const result = vm.runInNewContext(buildGoogleResultScanScript('appareldiary.com'), {
      window: { location, innerHeight: 700, innerWidth: 1000 },
      location,
      document,
      URL
    }) as {
      blocked: boolean;
      ready: boolean;
      resultsScanned: number;
      match?: {
        url: string;
        title: string;
        organicIndex: number;
        clickPoint?: { x: number; y: number };
      };
    };

    expect(result.blocked).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.match?.url).toBe(targetUrl);
    expect(result.match?.title).toContain('RMG Cutting Process');
    expect(result.match?.clickPoint).toEqual({ x: 325, y: 302 });
  });
});
