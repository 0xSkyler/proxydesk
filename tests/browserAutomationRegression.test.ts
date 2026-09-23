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
  buildClickGoogleLiveTargetObserverScript,
  buildEphemeralPartitionName,
  buildInstallGoogleLiveTargetObserverScript,
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
      keepAliveHops: 0,
      keepAliveActivity: 'idle',
      keepAliveFailureCount: 0
    },
    restartAttempts: 0,
    googleBlockRetries: 0,
    keepAliveEnabled: false,
    keepAliveHops: 0,
    keepAliveNextAt: 0,
    keepAliveBusy: false,
    keepAliveBusySince: 0,
    keepAliveGeneration: 0,
    keepAliveLastHeartbeatAt: 0,
    keepAliveFailureCount: 0,
    keepAliveVisited: new Set<string>(),
    controlledKeepAliveHost: null,
    controlledKeepAliveContinuous: false
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

  it('does not let Chromium background loading block a DOM-ready Keep Alive action', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({});
    const webContents = {
      getURL: () => 'https://appareldiary.com/article/test',
      isDestroyed: () => false,
      isLoading: () => true,
      executeJavaScript
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 10, webContents);

    const internals = manager as unknown as {
      browsers: Map<number, {
        keepAliveEnabled: boolean;
        keepAliveNextAt: number;
      }>;
      tickKeepAlive: () => void;
    };
    const managed = internals.browsers.get(10);
    if (!managed) throw new Error('Missing test browser.');
    managed.keepAliveEnabled = true;
    managed.keepAliveNextAt = 0;

    internals.tickKeepAlive();
    await Promise.resolve();
    await Promise.resolve();

    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    clearKeepAliveTimer(manager);
  });

  it('recovers a stale busy Keep Alive worker instead of staying active and idle forever', () => {
    const webContents = {
      getURL: () => 'https://appareldiary.com/article/test',
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript: vi.fn()
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 14, webContents);

    const internals = manager as unknown as {
      browsers: Map<number, {
        keepAliveEnabled: boolean;
        keepAliveBusy: boolean;
        keepAliveBusySince: number;
        keepAliveNextAt: number;
      }>;
      tickKeepAlive: () => void;
    };
    const managed = internals.browsers.get(14);
    if (!managed) throw new Error('Missing test browser.');
    managed.keepAliveEnabled = true;
    managed.keepAliveBusy = true;
    managed.keepAliveBusySince = Date.now() - 30_000;
    managed.keepAliveNextAt = 0;

    internals.tickKeepAlive();

    const state = manager.getAll().find((browser) => browser.id === 14);
    expect(state?.keepAliveActivity).toBe('recovering');
    expect(state?.keepAliveFailureCount).toBe(1);
    expect(webContents.executeJavaScript).not.toHaveBeenCalled();
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

  it('uses the exact detected Google result URL as a final fallback if synthetic clicks are ignored', async () => {
    const controlledHost = 'staging.example.com';
    const targetUrl = `https://${controlledHost}/article/test`;
    let currentUrl = 'https://www.google.com/search?q=test+article';

    const webContents = {
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => false,
      stop: vi.fn(),
      executeJavaScript: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('resultsScanned')) {
          return {
            blocked: false,
            ready: true,
            resultsScanned: 5,
            observedResults: 5,
            signature: 'stable',
            match: {
              url: targetUrl,
              title: 'Test Article',
              organicIndex: 0
            }
          };
        }
        return false;
      }),
      sendInputEvent: vi.fn(),
      loadURL: vi.fn().mockImplementation(async (url: string) => {
        currentUrl = url;
      })
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 13, webContents);
    const token = manager.startMeasurementSession(13);

    const clicked = await manager.clickControlledGoogleResult(
      13,
      'test article',
      controlledHost,
      targetUrl,
      token
    );

    expect(clicked).toBe(true);
    expect(webContents.loadURL).toHaveBeenCalledWith(targetUrl);
    expect(currentUrl).toBe(targetUrl);
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

describe('strong Google DOM text matching', () => {
  it('recognizes the visible host + keyword card even when the title link is Google-wrapped', () => {
    const clicked = vi.fn();
    const titleText = 'RMG Cutting Process: A Stage-by-Stage Control Guide';
    const cardText =
      'appareldiary.com\n' +
      titleText +
      '\nThe RMG cutting process operates on 60–70%. Cutting is also a batch process.';

    const h3 = { innerText: titleText, parentElement: null as unknown };
    const anchorNode = {
      href: 'https://www.google.com/search?ved=wrapped-result',
      innerText: titleText,
      parentElement: null as unknown,
      target: '',
      getAttribute: (name: string) => {
        if (name === 'href') return 'https://www.google.com/search?ved=wrapped-result';
        if (name === 'aria-label') return null;
        if (name === 'data-href' || name === 'data-url') return null;
        return null;
      },
      querySelector: (selector: string) =>
        selector === 'h3,h2,h1' ? h3 : null,
      getBoundingClientRect: () => ({
        left: 50,
        top: 190,
        width: 690,
        height: 42,
        right: 740,
        bottom: 232
      }),
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      dispatchEvent: vi.fn(),
      click: clicked
    };

    const card = {
      innerText: cardText,
      parentElement: null as unknown,
      querySelectorAll: (selector: string) =>
        selector === 'a[href],a[data-href],a[data-url]' ? [anchorNode] : []
    };
    anchorNode.parentElement = card;
    h3.parentElement = anchorNode;

    const domainNode = {
      innerText: 'appareldiary.com',
      parentElement: card
    };

    const root = {
      innerText: cardText,
      querySelectorAll: (selector: string) => {
        if (selector === 'a[href]') return [anchorNode];
        if (selector === 'cite,span,div,h3,h2,a') return [domainNode, h3];
        if (selector === 'h3,h2') return [h3];
        return [];
      }
    };

    const document = {
      body: { innerText: cardText },
      documentElement: {},
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = { href: 'https://www.google.com/search?q=rmg+cutting' };
    const windowObject: Record<string, unknown> = { location };

    class MutationObserverMock {
      constructor(_callback: () => void) {}
      observe(): void {}
      disconnect(): void {}
    }

    const context = vm.createContext({
      window: windowObject,
      document,
      location,
      URL,
      MutationObserver: MutationObserverMock,
      setInterval: () => 1,
      clearInterval: () => undefined,
      Date
    });

    const state = vm.runInContext(
      buildInstallGoogleLiveTargetObserverScript('appareldiary.com', 'rmg cutting'),
      context
    ) as {
      targetTextSeen?: boolean;
      match?: { url: string; title: string; clickPoint?: { x: number; y: number } };
    };

    expect(state.targetTextSeen).toBe(true);
    expect(state.match?.title).toContain('RMG Cutting Process');
    expect(state.match?.clickPoint).toBeDefined();

    const clickedResult = vm.runInContext(
      buildClickGoogleLiveTargetObserverScript(),
      context
    ) as boolean;

    expect(clickedResult).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

describe('Google live-result observation', () => {
  it('detects keyword + website in the live page watcher and clicks the stored result anchor', () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    const clicked = vi.fn();
    const disconnected = vi.fn();

    const card = {
      innerText:
        'appareldiary.com\nRMG Cutting Process: A Stage-by-Stage Control Guide\n' +
        'The RMG cutting process operates on 60–70%.',
      parentElement: null
    };

    const anchor = {
      href: targetUrl,
      innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
      parentElement: card,
      target: '',
      getAttribute: (name: string) => {
        if (name === 'href') return targetUrl;
        if (name === 'aria-label') return null;
        return null;
      },
      querySelector: (selector: string) =>
        selector === 'h3'
          ? { innerText: 'RMG Cutting Process: A Stage-by-Stage Control Guide' }
          : null,
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      click: clicked
    };

    const root = {
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? [anchor] : [])
    };
    const document = {
      body: {
        innerText: card.innerText,
        querySelectorAll: () => []
      },
      documentElement: {},
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = { href: 'https://www.google.com/search?q=rmg+cutting' };
    const windowObject: Record<string, unknown> = { location };

    class MutationObserverMock {
      constructor(_callback: () => void) {}
      observe(): void {}
      disconnect(): void {
        disconnected();
      }
    }

    const context = vm.createContext({
      window: windowObject,
      document,
      location,
      URL,
      MutationObserver: MutationObserverMock,
      setInterval: () => 1,
      clearInterval: () => undefined,
      Date
    });

    const state = vm.runInContext(
      buildInstallGoogleLiveTargetObserverScript('appareldiary.com', 'rmg cutting'),
      context
    ) as {
      match?: { url: string; title: string };
    };

    expect(state.match?.url).toBe(targetUrl);
    expect(state.match?.title).toContain('RMG Cutting Process');

    const clickedResult = vm.runInContext(
      buildClickGoogleLiveTargetObserverScript(),
      context
    ) as boolean;

    expect(clickedResult).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalled();
  });

  it('locks page 1 until a delayed target appears, opens it, and never requests page 2', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    let readCount = 0;
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const loadURL = vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      loading = true;
      setTimeout(() => emit('dom-ready'), 5);
    });

    const executeJavaScript = vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('new MutationObserver')) {
        return {
          blocked: false,
          observedResults: 2,
          signature: 'partial-1'
        };
      }

      if (script.includes('watcher && watcher.click')) {
        currentUrl = targetUrl;
        loading = false;
        return true;
      }

      if (script.includes('delete window.__proxyDeskGoogleWatcher')) {
        return true;
      }

      readCount += 1;
      if (readCount < 4) {
        return {
          blocked: false,
          observedResults: 2 + readCount,
          signature: 'partial-' + readCount
        };
      }

      return {
        blocked: false,
        observedResults: 7,
        signature: 'complete',
        matchedAt: Date.now(),
        match: {
          url: targetUrl,
          title: 'RMG Cutting Process: A Stage-by-Stage Control Guide',
          organicIndex: 2
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
      executeJavaScript
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

    expect(readCount).toBeGreaterThanOrEqual(4);
    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(String(loadURL.mock.calls[0][0])).not.toContain('start=10');
    expect(result.status).toBe('matched');
    expect(result.resultPage).toBe(1);
    expect(result.matchedUrl).toBe(targetUrl);
    expect(result.interactionStatus).toBe('opened');
    expect(currentUrl).toBe(targetUrl);
  });

  it('uses the observer-captured exact result URL if the in-page click is ignored', async () => {
    const targetUrl = 'https://appareldiary.com/article/rmg-cutting';
    let currentUrl = 'about:blank';
    let loading = false;
    const handlers = new Map<string, Set<() => void>>();
    let resultRead = false;

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const loadURL = vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      loading = false;
      setTimeout(() => emit('dom-ready'), 1);
    });

    const executeJavaScript = vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('new MutationObserver')) {
        return {
          blocked: false,
          observedResults: 6,
          signature: 'stable'
        };
      }
      if (script.includes('watcher && watcher.click')) return false;
      if (script.includes('delete window.__proxyDeskGoogleWatcher')) return true;

      if (!resultRead) {
        resultRead = true;
        return {
          blocked: false,
          observedResults: 6,
          signature: 'stable',
          match: {
            url: targetUrl,
            title: 'RMG Cutting Process',
            organicIndex: 1
          }
        };
      }
      return null;
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
      executeJavaScript
    };

    const manager = new BrowserManager();
    installManagedBrowser(manager, 2, webContents);
    const token = manager.startMeasurementSession(2);

    const result = await manager.broadcastSearch(
      2,
      'rmg cutting',
      'appareldiary.com',
      10,
      token
    );

    expect(result.status).toBe('matched');
    expect(result.interactionStatus).toBe('opened');
    expect(loadURL).toHaveBeenLastCalledWith(targetUrl);
    expect(currentUrl).toBe(targetUrl);
  });

  it('returns PAUSED when the live observer sees a Google challenge', async () => {
    let currentUrl = 'about:blank';
    const handlers = new Map<string, Set<() => void>>();

    const emit = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    };

    const webContents = {
      loadURL: vi.fn().mockImplementation(async (url: string) => {
        currentUrl = url;
        setTimeout(() => emit('dom-ready'), 1);
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
        if (script.includes('new MutationObserver')) {
          return {
            blocked: true,
            observedResults: 0,
            signature: ''
          };
        }
        if (script.includes('delete window.__proxyDeskGoogleWatcher')) return true;
        return {
          blocked: true,
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
    expect(webContents.loadURL).toHaveBeenCalledTimes(1);
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
