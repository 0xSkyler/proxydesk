import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserView: class {},
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  session: { fromPartition: vi.fn() }
}));

import {
  BrowserManager,
  buildGoogleAutoClickInstallerScript,
  buildGoogleResultScanScript
} from '../src/main/BrowserManager';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('browser automation regressions', () => {
  it('installs an in-page watcher that clicks an already-visible result immediately', () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    const click = vi.fn();
    const rect = { left: 80, top: 280, width: 520, height: 36, right: 600, bottom: 316 };
    const anchor = {
      href: targetUrl,
      innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
      target: '',
      getAttribute: (name: string) => (name === 'href' ? targetUrl : null),
      getBoundingClientRect: () => rect,
      querySelector: () => ({ innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide' }),
      closest: () => resultCard,
      parentElement: null,
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      click
    };
    const resultCard = {
      innerText: 'appareldiary.com\nRMG Cutting Process: A Stage-by-Stage Control Guide',
      parentElement: null
    };
    const root = { querySelectorAll: (selector: string) => (selector === 'a[href]' ? [anchor] : []) };
    const document = {
      body: { innerText: 'Google Search results' },
      documentElement: {},
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = {
      href: 'https://www.google.com/search?q=rmg+cutting',
      assign: vi.fn((url: string) => { location.href = url; })
    };
    class MutationObserverStub {
      observe() {}
      disconnect() {}
    }

    const state = vm.runInNewContext(buildGoogleAutoClickInstallerScript('appareldiary'), {
      window: { location, innerHeight: 800, innerWidth: 1200 },
      location,
      document,
      URL,
      MutationObserver: MutationObserverStub,
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: () => 1
    }) as { status: string; url?: string; title?: string };

    expect(state.status).toBe('clicked');
    expect(state.url).toBe(targetUrl);
    expect(state.title).toContain('RMG Cutting Process');
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('hard-follows the exact matched SERP URL when Google ignores the page click', () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    const click = vi.fn();
    const rect = { left: 80, top: 280, width: 520, height: 36, right: 600, bottom: 316 };
    const card = {
      innerText: 'appareldiary.com\nRMG Cutting Process: A Stage-by-Stage Control Guide',
      parentElement: null
    };
    const anchor = {
      href: targetUrl,
      innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
      target: '',
      getAttribute: (name: string) => (name === 'href' ? targetUrl : null),
      getBoundingClientRect: () => rect,
      querySelector: () => ({ innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide' }),
      closest: () => card,
      parentElement: null,
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      click
    };
    const root = { querySelectorAll: (selector: string) => (selector === 'a[href]' ? [anchor] : []) };
    const document = {
      body: { innerText: 'Google Search results' },
      documentElement: {},
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = {
      href: 'https://www.google.com/search?q=rmg+cutting',
      assign: vi.fn((url: string) => { location.href = url; })
    };
    class MutationObserverStub {
      observe() {}
      disconnect() {}
    }

    const state = vm.runInNewContext(buildGoogleAutoClickInstallerScript('appareldiary'), {
      window: { location, innerHeight: 800, innerWidth: 1200 },
      location,
      document,
      URL,
      MutationObserver: MutationObserverStub,
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: (cb: () => void) => { cb(); return 1; }
    }) as { status: string; url?: string };

    expect(state.status).toBe('clicked');
    expect(click).toHaveBeenCalledTimes(1);
    expect(location.assign).toHaveBeenCalledWith(targetUrl);
    expect(location.href).toBe(targetUrl);
  });
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
      on: vi.fn(),
      removeListener: vi.fn(),
      stop: vi.fn(),
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
      manager.broadcastSearch(1, 'safety stock', 'appareldiary', 1),
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
  it('stops a still-loading Google page at dom-ready and never paginates past a visible first-page target', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    let stopped = false;
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };
    const on = vi.fn((event: string, handler: () => void) => {
      const set = handlers.get(event) ?? new Set<() => void>();
      set.add(handler);
      handlers.set(event, set);
    });
    const removeListener = vi.fn((event: string, handler: () => void) => {
      handlers.get(event)?.delete(handler);
    });

    const loadURL = vi.fn().mockImplementation((url: string) => {
      currentUrl = url;
      loading = true;
      setTimeout(() => emit('dom-ready'), 5);
      // Simulate a proxy that leaves Google loading forever.
      return new Promise<void>(() => undefined);
    });
    const stop = vi.fn(() => {
      loading = false;
      stopped = true;
    });
    const executeJavaScript = vi.fn().mockImplementation(async (script: string) => {
      if (!stopped) return new Promise<never>(() => undefined);
      if (script.includes('__proxydeskSeoAutoClick')) {
        currentUrl = targetUrl;
        return {
          status: 'clicked',
          url: targetUrl,
          title: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
          organicIndex: 0
        };
      }
      return {
        blocked: false,
        ready: true,
        resultsScanned: 1,
        match: { url: targetUrl, title: 'RMG Cutting Process: A Stage-by-Stage Control Guide', organicIndex: 0 }
      };
    });

    const webContents = {
      loadURL,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => loading,
      on,
      removeListener,
      stop,
      executeJavaScript,
      sendInputEvent: vi.fn()
    };
    const managed = {
      id: 10,
      view: { webContents },
      session: {},
      state: { id: 10, keepAliveEnabled: false, keepAliveHops: 0, loading: true },
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
    internals.browsers.set(10, managed);

    const result = await Promise.race([
      manager.broadcastSearch(10, 'rmg cutting', 'appareldiary.com', 5),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('SEO scanner stayed blocked behind Google loading')), 900)
      )
    ]);

    expect(stop).toHaveBeenCalled();
    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('matched');
    expect(result.resultPage).toBe(1);
    expect(result.landedUrl).toBe(targetUrl);

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
      on: vi.fn(),
      removeListener: vi.fn(),
      stop: vi.fn(),
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
    const siteAnchor = {
      href: 'https://appareldiary.com/',
      innerText: 'appareldiary.com',
      getAttribute: (name: string) => (name === 'href' ? 'https://appareldiary.com/' : null),
      querySelector: () => null,
      closest: (selector: string) => (selector.includes('MjjYud') ? resultCard : null),
      parentElement: null,
      getBoundingClientRect: () => ({ left: 112, top: 228, width: 180, height: 24, right: 292, bottom: 252 }),
      scrollIntoView: vi.fn()
    };
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
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? [siteAnchor, titleAnchor] : []),
      closest: () => null
    };
    const searchRoot = {
      querySelectorAll: (selector: string) => {
        if (selector === 'a[href]') return [siteAnchor, titleAnchor];
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
