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
): void {
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
  };
  internals.browsers.set(id, managed);
}

function clearKeepAliveTimer(manager: BrowserManager): void {
  const internals = manager as unknown as { keepAliveTimer: NodeJS.Timeout | null };
  if (internals.keepAliveTimer) clearInterval(internals.keepAliveTimer);
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

describe('manual Keep Alive', () => {
  it('can be started and stopped explicitly for one browser', () => {
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

    clearKeepAliveTimer(manager);
  });

  it('performs exactly two down/up cycles and does not click links when link following is disabled', async () => {
    const clicked = vi.fn();
    const scrollBy = vi.fn();
    const root = { scrollHeight: 600, clientHeight: 600 };

    const articleAnchor = {
      href: 'https://appareldiary.com/article/another-rmg-article',
      textContent: 'Another RMG Article',
      target: '',
      hasAttribute: () => false,
      getAttribute: () => '',
      closest: () => ({}),
      querySelector: () => ({ innerText: 'Another RMG Article' }),
      getBoundingClientRect: () => ({ width: 200, height: 30 }),
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      click: clicked
    };

    const document = {
      scrollingElement: root,
      documentElement: root,
      body: { scrollHeight: 600 },
      querySelectorAll: () => [articleAnchor]
    };
    const location = { href: 'https://appareldiary.com/article/current' };

    const result = await vm.runInNewContext(
      buildKeepAliveActionScript(false, [location.href]),
      {
        window: {
          innerHeight: 600,
          scrollY: 0,
          scrollTo: vi.fn(),
          scrollBy
        },
        document,
        location,
        URL,
        performance: { now: () => 0 },
        requestAnimationFrame: (cb: (time: number) => void) => cb(1000),
        setTimeout: (cb: () => void) => {
          cb();
          return 1;
        },
        Promise,
        Set,
        Math
      }
    ) as { clickedUrl?: string };

    expect(scrollBy).toHaveBeenCalledTimes(4);
    expect(clicked).not.toHaveBeenCalled();
    expect(result.clickedUrl).toBeUndefined();
  });
});

describe('controlled test interaction', () => {
  it('clicks an exact controlled-test Google result and verifies the landing host', async () => {
    const controlledHost = 'seo-test.appareldiary.com';
    const targetUrl = `https://${controlledHost}/article/rmg-cutting`;
    let currentUrl = 'https://www.google.com/search?q=rmg+cutting';

    const webContents = {
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => false,
      stop: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue({
        blocked: false,
        ready: true,
        resultsScanned: 6,
        observedResults: 6,
        signature: 'stable',
        match: {
          url: targetUrl,
          title: 'RMG Cutting Process',
          organicIndex: 1,
          clickPoint: { x: 240, y: 300 }
        }
      }),
      sendInputEvent: vi.fn((event: { type: string }) => {
        if (event.type === 'mouseUp') currentUrl = targetUrl;
      })
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 11, webContents);
    const token = manager.startMeasurementSession(11);

    const clicked = await manager.clickControlledGoogleResult(
      11,
      'rmg cutting',
      controlledHost,
      targetUrl,
      token
    );

    expect(clicked).toBe(true);
    expect(currentUrl).toBe(targetUrl);
    expect(webContents.sendInputEvent).toHaveBeenCalled();
  });

  it('refuses a controlled click when the detected result host differs from the configured host', async () => {
    const webContents = {
      getURL: () => 'https://www.google.com/search?q=rmg+cutting',
      isDestroyed: () => false,
      isLoading: () => false,
      stop: vi.fn(),
      executeJavaScript: vi.fn(),
      sendInputEvent: vi.fn()
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 12, webContents);
    const token = manager.startMeasurementSession(12);

    const clicked = await manager.clickControlledGoogleResult(
      12,
      'rmg cutting',
      'seo-test.appareldiary.com',
      'https://appareldiary.com/article/rmg-cutting',
      token
    );

    expect(clicked).toBe(false);
    expect(webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('limits controlled Keep Alive article hopping to the exact allowed host', async () => {
    const clickedInside = vi.fn();
    const clickedOutside = vi.fn();
    const root = { scrollHeight: 600, clientHeight: 600 };

    const inside = {
      href: 'https://seo-test.appareldiary.com/article/next',
      textContent: 'Next controlled test article',
      target: '',
      hasAttribute: () => false,
      getAttribute: () => '',
      closest: () => ({}),
      querySelector: () => ({ innerText: 'Next controlled test article' }),
      getBoundingClientRect: () => ({ width: 200, height: 30 }),
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      click: clickedInside
    };
    const outside = {
      ...inside,
      href: 'https://appareldiary.com/article/production',
      textContent: 'Production article',
      click: clickedOutside
    };

    const location = { href: 'https://seo-test.appareldiary.com/article/current' };
    const result = await vm.runInNewContext(
      buildKeepAliveActionScript(
        true,
        [location.href],
        'seo-test.appareldiary.com'
      ),
      {
        window: {
          innerHeight: 600,
          scrollY: 0,
          scrollTo: vi.fn(),
          scrollBy: vi.fn()
        },
        document: {
          scrollingElement: root,
          documentElement: root,
          body: { scrollHeight: 600 },
          querySelectorAll: () => [outside, inside]
        },
        location,
        URL,
        performance: { now: () => 0 },
        requestAnimationFrame: (cb: (time: number) => void) => cb(1000),
        setTimeout: (cb: () => void) => {
          cb();
          return 1;
        },
        Promise,
        Set,
        Math
      }
    ) as { clickedUrl?: string };

    expect(clickedOutside).not.toHaveBeenCalled();
    expect(clickedInside).toHaveBeenCalledTimes(1);
    expect(result.clickedUrl).toBe('https://seo-test.appareldiary.com/article/next');
  });
});

describe('Google SEO measurement', () => {
  it('recognizes visible website + keyword text when Google splits domain and title markup', () => {
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
    ) as { match?: { url: string; title: string } };

    expect(result.match?.url).toBe(targetUrl);
    expect(result.match?.title).toContain('RMG Cutting Process');
  });

  it('records a target match without clicking or navigating to the site', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    const handlers = new Map<string, Set<() => void>>();
    const sendInputEvent = vi.fn();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const webContents = {
      loadURL: vi.fn().mockImplementation((url: string) => {
        currentUrl = url;
        loading = true;
        setTimeout(() => emit('dom-ready'), 5);
        return new Promise<void>(() => undefined);
      }),
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
      executeJavaScript: vi.fn().mockResolvedValue({
        blocked: false,
        ready: true,
        resultsScanned: 7,
        observedResults: 7,
        signature: 'stable-results',
        match: {
          url: targetUrl,
          title: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
          organicIndex: 2,
          clickPoint: { x: 240, y: 290 }
        }
      }),
      sendInputEvent
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 1, webContents);
    const token = manager.startMeasurementSession(1);

    const result = await manager.broadcastSearch(
      1,
      'rmg cutting',
      'appareldiary.com',
      20,
      token
    );

    expect(result.status).toBe('matched');
    expect(result.matchedUrl).toBe(targetUrl);
    expect(result.resultPage).toBe(1);
    expect(result.keepAliveStarted).toBe(false);
    expect(currentUrl).toContain('google.');
    expect(sendInputEvent).not.toHaveBeenCalled();
  });

  it('waits on the same page when the target appears after a partial render', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    let scans = 0;
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const webContents = {
      loadURL: vi.fn().mockImplementation((url: string) => {
        currentUrl = url;
        loading = true;
        setTimeout(() => emit('dom-ready'), 5);
        return new Promise<void>(() => undefined);
      }),
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
      executeJavaScript: vi.fn().mockImplementation(async () => {
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
            organicIndex: 2
          }
        };
      })
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 2, webContents);
    const token = manager.startMeasurementSession(2);

    const result = await manager.broadcastSearch(
      2,
      'rmg cutting',
      'appareldiary.com',
      20,
      token
    );

    expect(scans).toBeGreaterThanOrEqual(4);
    expect(webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('matched');
    expect(result.resultPage).toBe(1);
  });

  it('returns PAUSED on a Google challenge and reports recovery when normal results return', async () => {
    let currentUrl =
      'https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Drmg%2Bcutting';
    const handlers = new Map<string, Set<() => void>>();

    const webContents = {
      loadURL: vi.fn().mockImplementation((_url: string) => {
        return Promise.resolve();
      }),
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => false,
      on: (event: string, handler: () => void) => {
        const set = handlers.get(event) ?? new Set<() => void>();
        set.add(handler);
        handlers.set(event, set);
      },
      removeListener: (event: string, handler: () => void) => handlers.get(event)?.delete(handler),
      stop: vi.fn(),
      executeJavaScript: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('hasResults')) {
          return { blocked: false, hasResults: true };
        }
        return {
          blocked: true,
          ready: true,
          resultsScanned: 0,
          observedResults: 0,
          signature: ''
        };
      })
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 3, webContents);
    const token = manager.startMeasurementSession(3);

    const paused = await manager.broadcastSearch(
      3,
      'rmg cutting',
      'appareldiary.com',
      20,
      token
    );

    expect(paused.status).toBe('paused');

    setTimeout(() => {
      currentUrl = 'https://www.google.com/search?q=rmg+cutting';
    }, 10);

    const recovered = await manager.waitForGoogleRecovery(3, 2_000);
    expect(recovered).toBe(true);
  });

  it('invalidates an old measurement token when a new proxy cycle starts', () => {
    const webContents = {
      getURL: () => 'https://www.google.com/search?q=rmg+cutting',
      isDestroyed: () => false,
      isLoading: () => false,
      stop: vi.fn()
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 4, webContents);

    const first = manager.startMeasurementSession(4);
    expect(manager.isMeasurementSessionCurrent(4, first)).toBe(true);

    manager.cancelMeasurementSession(4);
    expect(manager.isMeasurementSessionCurrent(4, first)).toBe(false);
    expect(webContents.stop).toHaveBeenCalled();
  });
});
