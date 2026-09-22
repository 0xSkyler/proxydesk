import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserView: class {},
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  session: { fromPartition: vi.fn() }
}));

import {
  BrowserManager,
  buildEphemeralPartitionName,
  buildGoogleResultScanScript,
  buildKeepAliveActionScript
} from '../src/main/BrowserManager';

function installManagedBrowser(
  manager: BrowserManager,
  id: number,
  webContents: Record<string, unknown>
): NodeJS.Timeout | null {
  const managed = {
    id,
    view: { webContents },
    session: {},
    state: {
      id,
      label: `Browser ${id}`,
      url: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      proxy: null,
      connectionStatus: 'idle',
      crashCount: 0,
      keepAliveEnabled: false,
      keepAliveHops: 0
    },
    restartAttempts: 0,
    googleBlockRetries: 0,
    keepAliveEnabled: false,
    keepAliveHops: 0,
    keepAliveNextAt: 0,
    keepAliveBusy: false,
    keepAliveVisited: new Set<string>()
  };

  const internals = manager as unknown as {
    browsers: Map<number, unknown>;
    keepAliveTimer: NodeJS.Timeout | null;
  };
  internals.browsers.set(id, managed);
  return internals.keepAliveTimer;
}

describe('browser session isolation', () => {
  it('uses a different in-memory partition for every browser and process run', () => {
    const a = buildEphemeralPartitionName(1, 1001);
    const b = buildEphemeralPartitionName(2, 1001);
    const restarted = buildEphemeralPartitionName(1, 2002);

    expect(a).not.toContain('persist:');
    expect(a).not.toBe(b);
    expect(a).not.toBe(restarted);
  });
});

describe('Keep Alive controls', () => {
  it('can be started and stopped explicitly for an individual browser', async () => {
    const webContents = {
      getURL: () => 'https://appareldiary.com/article/test',
      isDestroyed: () => false,
      isLoading: () => true
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 9, webContents);

    manager.setBrowserKeepAlive(9, true, true);
    expect(manager.getAll().find((browser) => browser.id === 9)?.keepAliveEnabled).toBe(true);

    manager.setBrowserKeepAlive(9, false, false);
    expect(manager.getAll().find((browser) => browser.id === 9)?.keepAliveEnabled).toBe(false);

    await Promise.resolve();
    const internals = manager as unknown as { keepAliveTimer: NodeJS.Timeout | null };
    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });
});

describe('Keep Alive article hopping', () => {
  it('scrolls down/up exactly twice and clicks an internal article link', async () => {
    const clicked = vi.fn();
    const scrollBy = vi.fn();

    const articleAnchor = {
      href: 'https://appareldiary.com/article/another-rmg-article',
      textContent: 'Another RMG Article',
      target: '',
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === 'rel' ? '' : null),
      closest: (selector: string) => (selector === 'article' ? {} : null),
      querySelector: () => ({ innerText: 'Another RMG Article' }),
      getBoundingClientRect: () => ({ width: 200, height: 30 }),
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      click: clicked
    };

    const root = {
      scrollHeight: 600,
      clientHeight: 600
    };

    const document = {
      scrollingElement: root,
      documentElement: root,
      body: {
        scrollHeight: 600,
        querySelectorAll: () => []
      },
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? [articleAnchor] : [])
    };

    const location = { href: 'https://appareldiary.com/article/current' };
    const windowObject = {
      innerHeight: 600,
      scrollY: 0,
      scrollTo: vi.fn(),
      scrollBy
    };

    const result = await vm.runInNewContext(
      buildKeepAliveActionScript(true, ['https://appareldiary.com/article/current']),
      {
        window: windowObject,
        document,
        location,
        URL,
        performance: { now: () => 0 },
        requestAnimationFrame: (cb: (time: number) => void) => cb(1000),
        setTimeout: (cb: () => void) => { cb(); return 1; },
        Promise,
        Set,
        Math
      }
    ) as { clickedUrl?: string };

    expect(scrollBy).toHaveBeenCalledTimes(4);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(result.clickedUrl).toBe('https://appareldiary.com/article/another-rmg-article');
  });
});

describe('Google SEO page scanning', () => {
  it('recognizes a Google result from visible keyword + website text even when markup is split', () => {
    const targetUrl = 'https://appareldiary.com/article/precision-and-profit-rmg-cutting';
    const rect = { left: 48, top: 410, width: 720, height: 42, right: 768, bottom: 452 };

    const card = {
      innerText:
        'appareldiary.com\nhttps://appareldiary.com › article › precision-and-profit-a...\n' +
        'RMG Cutting Process: A Stage-by-Stage Control Guide\n' +
        'The RMG cutting process operates on 60–70%.',
      parentElement: null,
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? [titleAnchor] : [])
    };

    const titleAnchor = {
      href: targetUrl,
      innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
      getAttribute: (name: string) => (name === 'href' ? targetUrl : null),
      querySelector: (selector: string) =>
        selector === 'h3' ? { innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide' } : null,
      closest: () => card,
      parentElement: card,
      getBoundingClientRect: () => rect,
      scrollIntoView: vi.fn()
    };

    const domainNode = {
      innerText: 'appareldiary.com',
      parentElement: card,
      closest: (selector: string) => (selector === 'a[href]' ? null : card)
    };

    const root = {
      querySelectorAll: (selector: string) => {
        if (selector === 'a[href]') return [titleAnchor];
        if (selector === 'cite, span, div') return [domainNode];
        return [];
      }
    };

    const document = {
      body: { innerText: 'Google Search results' },
      readyState: 'interactive',
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = { href: 'https://www.google.com/search?q=rmg+cutting' };

    const result = vm.runInNewContext(
      buildGoogleResultScanScript('appareldiary.com', 'rmg cutting'),
      {
        window: { location, innerHeight: 800, innerWidth: 1200 },
        location,
        document,
        URL
      }
    ) as {
      ready: boolean;
      match?: { url: string; title: string };
    };

    expect(result.match?.url).toBe(targetUrl);
    expect(result.match?.title).toContain('RMG Cutting Process');
  });

  it('matches screenshot-style Google markup where domain and article title share a result card', () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    const rect = { left: 60, top: 280, width: 520, height: 34, right: 580, bottom: 314 };

    const card = {
      innerText:
        'appareldiary.com\nhttps://appareldiary.com › article › rmg-cutting\n' +
        'RMG Cutting Process: A Stage-by-Stage Control Guide',
      parentElement: null,
      querySelectorAll: () => [] as unknown[]
    };

    const anchor = {
      href: targetUrl,
      innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
      getAttribute: (name: string) => (name === 'href' ? targetUrl : null),
      querySelector: () => null,
      closest: () => card,
      parentElement: null,
      getBoundingClientRect: () => rect,
      scrollIntoView: vi.fn()
    };

    const root = {
      querySelectorAll: (selector: string) => {
        if (selector === 'a[href]') return [anchor];
        return [];
      }
    };
    const document = {
      body: { innerText: 'Google Search results' },
      readyState: 'interactive',
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = { href: 'https://www.google.com/search?q=rmg+cutting' };

    const result = vm.runInNewContext(buildGoogleResultScanScript('appareldiary.com', 'rmg cutting'), {
      window: { location, innerHeight: 800, innerWidth: 1200 },
      location,
      document,
      URL
    }) as {
      ready: boolean;
      match?: { url: string; title: string; clickPoint?: { x: number; y: number } };
    };

    expect(result.ready).toBe(true);
    expect(result.match?.url).toBe(targetUrl);
    expect(result.match?.title).toContain('RMG Cutting Process');
    expect(result.match?.clickPoint).toBeDefined();
  });

  it('stops a still-loading Google page, finds page-1 target, and never paginates away', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const loadURL = vi.fn().mockImplementation((url: string) => {
      currentUrl = url;
      loading = true;
      setTimeout(() => emit('dom-ready'), 5);
      return new Promise<void>(() => undefined);
    });

    const stop = vi.fn(() => {
      loading = false;
    });

    const sendInputEvent = vi.fn((event: { type: string }) => {
      if (event.type === 'mouseUp') currentUrl = targetUrl;
    });

    const executeJavaScript = vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('resultsScanned')) {
        return {
          blocked: false,
          ready: true,
          resultsScanned: 1,
          match: {
            url: targetUrl,
            title: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
            organicIndex: 0,
            clickPoint: { x: 250, y: 300 }
          }
        };
      }
      return { links: [] };
    });

    const webContents = {
      loadURL,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => loading,
      on: (event: string, handler: () => void) => {
        const set = handlers.get(event) ?? new Set<() => void>();
        set.add(handler);
        handlers.set(event, set);
      },
      removeListener: (event: string, handler: () => void) => handlers.get(event)?.delete(handler),
      stop,
      executeJavaScript,
      sendInputEvent
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 1, webContents);

    const result = await manager.broadcastSearch(1, 'rmg cutting', 'appareldiary.com', 5);

    expect(stop).toHaveBeenCalled();
    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('matched');
    expect(result.resultPage).toBe(1);
    expect(result.keepAliveStarted).toBe(true);

    const internals = manager as unknown as { keepAliveTimer: NodeJS.Timeout | null };
    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });

  it('waits on the same Google page when the target appears after the first partial render', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    let scans = 0;
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const loadURL = vi.fn().mockImplementation((url: string) => {
      currentUrl = url;
      loading = true;
      setTimeout(() => emit('dom-ready'), 5);
      return new Promise<void>(() => undefined);
    });

    const executeJavaScript = vi.fn().mockImplementation(async (script: string) => {
      if (!script.includes('resultsScanned')) return { links: [] };
      scans += 1;

      if (scans < 4) {
        return {
          blocked: false,
          ready: true,
          resultsScanned: 3,
          observedResults: 3,
          signature: 'partial-' + scans
        };
      }

      return {
        blocked: false,
        ready: true,
        resultsScanned: 7,
        observedResults: 7,
        signature: 'full-set',
        match: {
          url: targetUrl,
          title: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
          organicIndex: 2,
          clickPoint: { x: 240, y: 290 }
        }
      };
    });

    const webContents = {
      loadURL,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => loading,
      on: (event: string, handler: () => void) => {
        const set = handlers.get(event) ?? new Set<() => void>();
        set.add(handler);
        handlers.set(event, set);
      },
      removeListener: (event: string, handler: () => void) => handlers.get(event)?.delete(handler),
      stop: () => {
        loading = false;
      },
      executeJavaScript,
      sendInputEvent: vi.fn((event: { type: string }) => {
        if (event.type === 'mouseUp') currentUrl = targetUrl;
      })
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 3, webContents);

    const result = await manager.broadcastSearch(3, 'rmg cutting', 'appareldiary.com', 20);

    expect(scans).toBeGreaterThanOrEqual(4);
    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('matched');
    expect(result.resultPage).toBe(1);

    const internals = manager as unknown as { keepAliveTimer: NodeJS.Timeout | null };
    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });

  it('moves to later Google pages only after the current page is scanned without a target', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    let page = 0;
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const loadURL = vi.fn().mockImplementation((url: string) => {
      currentUrl = url;
      page = url.includes('start=10') ? 2 : 1;
      loading = true;
      setTimeout(() => emit('dom-ready'), 5);
      return new Promise<void>(() => undefined);
    });

    const webContents = {
      loadURL,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => loading,
      on: (event: string, handler: () => void) => {
        const set = handlers.get(event) ?? new Set<() => void>();
        set.add(handler);
        handlers.set(event, set);
      },
      removeListener: (event: string, handler: () => void) => handlers.get(event)?.delete(handler),
      stop: () => {
        loading = false;
      },
      executeJavaScript: vi.fn().mockImplementation(async (script: string) => {
        if (!script.includes('resultsScanned')) return { links: [] };
        if (page === 1) {
          return { blocked: false, ready: true, resultsScanned: 10 };
        }
        return {
          blocked: false,
          ready: true,
          resultsScanned: 3,
          match: {
            url: targetUrl,
            title: 'RMG Cutting Process',
            organicIndex: 2,
            clickPoint: { x: 200, y: 250 }
          }
        };
      }),
      sendInputEvent: vi.fn((event: { type: string }) => {
        if (event.type === 'mouseUp') currentUrl = targetUrl;
      })
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 2, webContents);

    const result = await manager.broadcastSearch(2, 'rmg cutting', 'appareldiary.com', 10);

    expect(loadURL).toHaveBeenCalledTimes(2);
    expect(String(loadURL.mock.calls[1][0])).toContain('start=10');
    expect(result.status).toBe('matched');
    expect(result.resultPage).toBe(2);
    expect(result.position).toBe(13);

    const internals = manager as unknown as { keepAliveTimer: NodeJS.Timeout | null };
    if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
  });
});
