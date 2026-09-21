import { EventEmitter } from 'node:events';
import { BrowserView, BrowserWindow, type WebContents } from 'electron';
import type {
  BrowserBounds,
  BrowserState,
  ProxyEndpoint,
  TrackerResult
} from '../shared/tracker';

interface ManagedBrowser {
  id: number;
  view: BrowserView;
  state: BrowserState;
  generation: number;
}

interface ScanMatch {
  url: string;
  title: string;
  organicIndex: number;
}

interface PageScan {
  blocked: boolean;
  resultsCount: number;
  match?: ScanMatch;
}

export class SeoBrowserManager extends EventEmitter {
  private window: BrowserWindow | null = null;
  private browsers = new Map<number, ManagedBrowser>();

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    for (const managed of this.browsers.values()) window.addBrowserView(managed.view);
  }

  getAll(): BrowserState[] {
    return Array.from(this.browsers.values())
      .map((managed) => ({ ...managed.state }))
      .sort((a, b) => a.id - b.id);
  }

  async syncCount(count: number): Promise<void> {
    const safeCount = Math.max(1, Math.min(20, Math.floor(count || 1)));
    const desired = new Set(Array.from({ length: safeCount }, (_, index) => index + 1));

    for (const id of desired) {
      if (!this.browsers.has(id)) this.createBrowser(id);
    }
    for (const id of Array.from(this.browsers.keys())) {
      if (!desired.has(id)) await this.destroyBrowser(id);
    }
  }

  setBounds(id: number, bounds: BrowserBounds): void {
    const managed = this.browsers.get(id);
    if (!managed) return;
    managed.view.setBounds({
      x: Math.floor(bounds.x),
      y: Math.floor(bounds.y),
      width: Math.max(1, Math.floor(bounds.width)),
      height: Math.max(1, Math.floor(bounds.height))
    });
  }

  async assignProxy(id: number, proxy: ProxyEndpoint): Promise<void> {
    const managed = this.requireBrowser(id);
    managed.state.proxy = proxy;
    managed.state.status = 'proxy';
    managed.state.message = `${proxy.protocol.toUpperCase()} ${proxy.host}:${proxy.port}`;
    this.emitState(managed);

    await managed.view.webContents.session.setProxy({
      mode: 'fixed_servers',
      proxyRules: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      proxyBypassRules: '<-loopback>'
    });
  }

  async search(id: number, query: string, target: string, maxPages: number): Promise<TrackerResult> {
    const managed = this.requireBrowser(id);
    const generation = ++managed.generation;
    const normalizedTarget = normalizeTarget(target);
    const pages = Math.max(1, Math.min(20, Math.floor(maxPages || 1)));

    managed.state.status = 'searching';
    managed.state.message = 'Searching Google…';
    managed.state.currentPage = 1;
    this.emitState(managed);

    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      if (generation !== managed.generation) return cancelledResult(id, managed.state.proxy);

      const pageNumber = pageIndex + 1;
      managed.state.currentPage = pageNumber;
      managed.state.message = `Scanning Google page ${pageNumber}`;
      this.emitState(managed);

      const searchUrl = buildGoogleSearchUrl(query, pageIndex);
      const opened = await this.openUntilDomReady(managed.view.webContents, searchUrl, generation, managed);
      if (!opened.ok) {
        managed.state.status = 'error';
        managed.state.message = opened.error;
        this.emitState(managed);
        return {
          browserId: id,
          status: 'error',
          proxy: managed.state.proxy,
          page: pageNumber,
          error: opened.error,
          finishedAt: new Date().toISOString()
        };
      }

      const scan = await this.scanVisibleResults(managed.view.webContents, normalizedTarget);
      if (!scan) {
        managed.state.status = 'error';
        managed.state.message = 'Could not inspect the rendered Google results.';
        this.emitState(managed);
        return {
          browserId: id,
          status: 'error',
          proxy: managed.state.proxy,
          page: pageNumber,
          error: managed.state.message,
          finishedAt: new Date().toISOString()
        };
      }

      if (scan.blocked) {
        managed.state.status = 'blocked';
        managed.state.message = 'Google challenge / unusual traffic page';
        this.emitState(managed);
        return {
          browserId: id,
          status: 'blocked',
          proxy: managed.state.proxy,
          page: pageNumber,
          error: managed.state.message,
          finishedAt: new Date().toISOString()
        };
      }

      if (scan.match) {
        const position = pageIndex * 10 + scan.match.organicIndex + 1;
        managed.state.status = 'matched';
        managed.state.message = `Found on page ${pageNumber}, position ${position}`;
        this.emitState(managed);

        // The scan schedules a real anchor click. If Google does not follow
        // it quickly, load the exact URL that was read from that SERP result.
        const landed = await waitForNonGoogleUrl(managed.view.webContents, 700);
        if (!landed) {
          void managed.view.webContents.loadURL(scan.match.url).catch(() => undefined);
        }

        return {
          browserId: id,
          status: 'matched',
          proxy: managed.state.proxy,
          page: pageNumber,
          position,
          matchedUrl: scan.match.url,
          title: scan.match.title,
          finishedAt: new Date().toISOString()
        };
      }

      // Only a completed scan with no target reaches this point. The next
      // Google page is never opened merely because the current one is still
      // loading.
    }

    managed.state.status = 'not-found';
    managed.state.message = `Target not found in the first ${pages} page(s)`;
    this.emitState(managed);
    return {
      browserId: id,
      status: 'not-found',
      proxy: managed.state.proxy,
      page: pages,
      finishedAt: new Date().toISOString()
    };
  }

  stopAll(): void {
    for (const managed of this.browsers.values()) {
      managed.generation += 1;
      managed.view.webContents.stop();
      if (managed.state.status === 'searching' || managed.state.status === 'proxy') {
        managed.state.status = 'idle';
        managed.state.message = 'Stopped';
        this.emitState(managed);
      }
    }
  }

  async destroyAll(): Promise<void> {
    for (const id of Array.from(this.browsers.keys())) await this.destroyBrowser(id);
  }

  private createBrowser(id: number): void {
    const view = new BrowserView({
      webPreferences: {
        partition: `seo-tracker-${id}-${Date.now()}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    const managed: ManagedBrowser = {
      id,
      view,
      generation: 0,
      state: {
        id,
        label: `Browser ${id}`,
        url: 'about:blank',
        loading: false,
        status: 'idle',
        currentPage: 0,
        proxy: null
      }
    };

    this.browsers.set(id, managed);
    this.window?.addBrowserView(view);

    const wc = view.webContents;
    wc.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('did-start-loading', () => {
      managed.state.loading = true;
      this.emitState(managed);
    });
    wc.on('did-stop-loading', () => {
      managed.state.loading = false;
      managed.state.url = wc.getURL();
      this.emitState(managed);
    });
    wc.on('did-navigate', (_event, url) => {
      managed.state.url = url;
      this.emitState(managed);
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      managed.state.url = url;
      this.emitState(managed);
    });

    void wc.loadURL('about:blank');
    this.emitState(managed);
  }

  private async destroyBrowser(id: number): Promise<void> {
    const managed = this.browsers.get(id);
    if (!managed) return;

    managed.generation += 1;
    managed.view.webContents.stop();
    this.window?.removeBrowserView(managed.view);
    managed.view.webContents.destroy();
    this.browsers.delete(id);
  }

  private requireBrowser(id: number): ManagedBrowser {
    const managed = this.browsers.get(id);
    if (!managed) throw new Error(`Browser ${id} does not exist.`);
    return managed;
  }

  private emitState(managed: ManagedBrowser): void {
    this.emit('stateChanged', { ...managed.state });
  }

  private async openUntilDomReady(
    wc: WebContents,
    url: string,
    generation: number,
    managed: ManagedBrowser
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    wc.stop();

    return new Promise((resolve) => {
      let settled = false;
      let paintTimer: NodeJS.Timeout | null = null;
      let fallbackTimer: NodeJS.Timeout | null = null;
      let failTimer: NodeJS.Timeout | null = null;
      let navigationError: string | null = null;

      const cleanup = () => {
        wc.removeListener('dom-ready', onDomReady);
        if (paintTimer) clearTimeout(paintTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (failTimer) clearTimeout(failTimer);
      };

      const finish = (result: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const stopAndRelease = () => {
        if (generation !== managed.generation) {
          finish({ ok: false, error: 'Search stopped.' });
          return;
        }
        if (isGoogleSearchUrl(wc.getURL()) && wc.isLoading()) wc.stop();
        setTimeout(() => finish({ ok: true }), 35);
      };

      const onDomReady = () => {
        if (!isGoogleSearchUrl(wc.getURL())) return;
        if (paintTimer) clearTimeout(paintTimer);
        // Results are server-rendered. Give Chromium only a brief paint
        // window, then stop slow images/scripts/subresources.
        paintTimer = setTimeout(stopAndRelease, 180);
      };

      wc.on('dom-ready', onDomReady);

      void wc.loadURL(url).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!/ERR_ABORTED|-3/i.test(message)) navigationError = message;
      });

      // If dom-ready is delayed/missed but the Google search URL has already
      // committed, do not sit behind a slow proxy waiting for full load.
      fallbackTimer = setTimeout(() => {
        if (isGoogleSearchUrl(wc.getURL())) {
          stopAndRelease();
          return;
        }
        if (navigationError) finish({ ok: false, error: navigationError });
      }, 1200);

      failTimer = setTimeout(() => {
        finish({
          ok: false,
          error: navigationError ?? 'Google did not render through this proxy within 5 seconds.'
        });
      }, 5000);
    });
  }

  private async scanVisibleResults(wc: WebContents, target: string): Promise<PageScan | null> {
    const script = buildGoogleScanScript(target);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const result = await promiseWithTimeout(
          wc.executeJavaScript(script, true) as Promise<PageScan>,
          700
        );
        if (result.blocked || result.match || result.resultsCount > 0) return result;
      } catch {
        // The document may have been released immediately after stop().
      }
      await delay(80);
    }
    return null;
  }
}

export function buildGoogleSearchUrl(query: string, pageIndex: number): string {
  const params = new URLSearchParams({ q: query.trim(), num: '10', hl: 'en' });
  if (pageIndex > 0) params.set('start', String(pageIndex * 10));
  return `https://www.google.com/search?${params.toString()}`;
}

export function normalizeTarget(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return trimmed.replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0];
  }
}

function isGoogleSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

export function buildGoogleScanScript(target: string): string {
  return `(function() {
    try {
      var target = ${JSON.stringify(target)};
      var body = (document.body && document.body.innerText) || '';
      if (/\\/sorry\\/|consent\\.google\\./i.test(location.href) ||
          /unusual traffic|not a robot|recaptcha/i.test(body.slice(0, 3500))) {
        return { blocked: true, resultsCount: 0 };
      }

      function cleanHost(host) {
        return String(host || '').toLowerCase().replace(/^www\\./, '').replace(/\\.$/, '');
      }

      function matchesHost(host) {
        host = cleanHost(host);
        if (!target) return false;
        if (target.indexOf('.') >= 0) return host === target || host.endsWith('.' + target);
        return host.split('.').indexOf(target) >= 0;
      }

      function unwrap(href) {
        try {
          var resolved = new URL(href, location.href);
          if (/(^|\\.)google\\.[a-z.]+$/i.test(resolved.hostname) && resolved.pathname === '/url') {
            return resolved.searchParams.get('url') || resolved.searchParams.get('q') || href;
          }
          return resolved.href;
        } catch (_) {
          return href;
        }
      }

      var root = document.querySelector('#search') || document.querySelector('#rso') || document.querySelector('main') || document.body;
      if (!root) return { blocked: false, resultsCount: 0 };

      var seen = Object.create(null);
      var results = [];
      var anchors = Array.prototype.slice.call(root.querySelectorAll('a[href]'));

      for (var i = 0; i < anchors.length; i += 1) {
        var anchor = anchors[i];
        var destination = unwrap(anchor.getAttribute('href') || anchor.href || '');
        var parsed;
        try { parsed = new URL(destination, location.href); } catch (_) { continue; }

        if (!/^https?:$/.test(parsed.protocol)) continue;
        if (/(^|\\.)google\\.[a-z.]+$/i.test(parsed.hostname)) continue;

        var heading = anchor.querySelector && anchor.querySelector('h3');
        var container = anchor.closest && anchor.closest('.MjjYud, .g, [data-hveid], [data-snhf]');
        if (!container) container = anchor.parentElement && anchor.parentElement.parentElement
          ? anchor.parentElement.parentElement
          : anchor.parentElement || anchor;

        var cardText = ((container && container.innerText) || anchor.innerText || '').slice(0, 1800);
        if (/\\bSponsored\\b/i.test(cardText.slice(0, 220))) continue;

        var hostMatch = matchesHost(parsed.hostname);
        var targetText = target.replace(/^www\\./, '');
        var textMatch = targetText && cardText.toLowerCase().indexOf(targetText) >= 0;

        // Normal organic results have an h3 title. If Google changes markup,
        // a direct target-host/text match is accepted as the fallback.
        if (!heading && !hostMatch && !textMatch) continue;

        var key = parsed.href;
        if (seen[key]) continue;
        seen[key] = true;

        results.push({
          anchor: anchor,
          url: parsed.href,
          title: ((heading && heading.innerText) || anchor.innerText || '').trim(),
          hostMatch: hostMatch,
          textMatch: textMatch
        });
      }

      for (var index = 0; index < results.length; index += 1) {
        var item = results[index];
        if (!item.hostMatch && !item.textMatch) continue;

        setTimeout(function(a) {
          try {
            a.target = '_self';
            a.scrollIntoView({ block: 'center', behavior: 'auto' });
            a.click();
          } catch (_) {}
        }.bind(null, item.anchor), 0);

        return {
          blocked: false,
          resultsCount: results.length,
          match: {
            url: item.url,
            title: item.title,
            organicIndex: index
          }
        };
      }

      return { blocked: false, resultsCount: results.length };
    } catch (_) {
      return { blocked: false, resultsCount: 0 };
    }
  })()`;
}

function cancelledResult(browserId: number, proxy: ProxyEndpoint | null): TrackerResult {
  return {
    browserId,
    status: 'error',
    proxy,
    error: 'Search stopped.',
    finishedAt: new Date().toISOString()
  };
}

async function waitForNonGoogleUrl(wc: WebContents, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(60);
    const url = wc.getURL();
    if (url && !isGoogleSearchUrl(url) && url !== 'about:blank') return url;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Page script timed out.')), timeoutMs)
    )
  ]);
}
