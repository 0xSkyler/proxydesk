import { EventEmitter } from 'node:events';
import { app, BrowserView, BrowserWindow, clipboard, session, type Session } from 'electron';
import type { BroadcastSearchResult, BrowserBounds, BrowserState } from '../shared/types/browser';
import type { ProxyRecord } from '../shared/types/proxy';
import { EPHEMERAL_PARTITION_PREFIX, PARTITION_PREFIX } from '../shared/constants';
import { buildGoogleSearchUrl, hostMatchesTarget, normalizeTargetHost, resultTextMentionsHost } from '../shared/seo';
import { logger } from './Logger';

/**
 * ARCHITECTURE NOTE — per-browser proxy isolation (see requirements #45, #68, #69)
 * ------------------------------------------------------------------------------
 * A single global `session.defaultSession.setProxy(...)` call cannot give
 * different browsers different proxies — it is one setting for the whole
 * app. Genuine per-browser isolation requires each workspace to run in its
 * own Electron `Session` object, because `Session#setProxy` is scoped to
 * that session alone, and cookies/localStorage/sessionStorage/HTTP cache
 * are already partitioned per-session by Electron.
 *
 * So each of the 10 browsers gets:
 *   - its own `session.fromPartition('persist:browser-N')` (or a
 *     non-persistent partition when "Persist sessions" is off), which
 *     isolates cookies, storage and cache automatically;
 *   - its own `ses.setProxy({ proxyRules })` call, so outbound network
 *     traffic for that browser alone goes through its assigned proxy.
 *
 * Proxy-authentication challenges ("this proxy needs a username/password")
 * are NOT emitted per-`Session` in current Electron — they only fire as a
 * single app-wide `app.on('login', (event, webContents, details, authInfo, callback) => ...)`
 * event, common to every session. `BrowserManager` therefore installs ONE
 * such handler and, on each callback, looks up which managed browser owns
 * the `webContents` that triggered it (via `webContents.id`) to find the
 * right proxy's credentials — so Browser 1's proxy password is still only
 * ever handed to Browser 1's own proxy challenge, never Browser 2's.
 *

 * Each browser's web content is rendered via a `BrowserView` attached to
 * the single top-level `BrowserWindow`, positioned with `setBounds` to
 * form the grid. `BrowserView` (rather than loading everything into one
 * WebContents/iframe soup) is what makes 10 fully-independent, isolated
 * Chromium renderer processes possible while still sharing one native
 * window/chrome. Electron's newer `WebContentsView` (Electron >= 30) is
 * the documented eventual replacement for `BrowserView`, but `BrowserView`
 * remains fully supported in this Electron version (31.x) and is used here
 * for broader compatibility; swapping to `WebContentsView` would only
 * change how the view attaches to the window, not the per-session-proxy
 * design above.
 */

export interface BrowserManagerOptions {
  persistSessions: boolean;
  startPage: string;
  userAgent: string;
  onCrash?: (id: number) => void;
  /** Fired when this browser lands on Google's "unusual traffic" / CAPTCHA
   * interstitial while browsing normally (not via the deliberate Google
   * Trust Check — see GoogleTrustChecker) — i.e. the exact problem that
   * check exists to catch, just discovered live instead of ahead of time.
   * `continueUrl` is the page the browser was actually trying to reach
   * (extracted from the interstitial's own `continue=` param), so the
   * caller can retry that specific page once a different proxy is in
   * place, rather than just reloading the interstitial itself. Only fires
   * while under MAX_GOOGLE_BLOCK_RETRIES for this browser — see
   * maybeHandleGoogleBlock. */
  onGoogleBlocked?: (id: number, continueUrl: string) => void;
}

/** Cap on automatic proxy swaps triggered by hitting Google's CAPTCHA page
 * in a row, before giving up and leaving it for a manual "Change Proxy"
 * click — without this, a proxy pool that's mostly Google-flagged (a real
 * possibility with free/public lists) could otherwise have a browser
 * silently burning through proxies forever. Resets on the next explicit
 * navigate() (fresh intent) or once a page loads that ISN'T the block page. */
const MAX_GOOGLE_BLOCK_RETRIES = 3;

interface ManagedBrowser {
  id: number;
  view: BrowserView;
  session: Session;
  state: BrowserState;
  restartAttempts: number;
  /** Consecutive Google-CAPTCHA hits since the last successful (non-block)
   * navigation or explicit navigate() call — see MAX_GOOGLE_BLOCK_RETRIES. */
  googleBlockRetries: number;
  keepAliveEnabled: boolean;
  keepAliveHops: number;
  keepAliveNextAt: number;
  keepAliveBusy: boolean;
  keepAliveVisited: Set<string>;
}

/**
 * If `url` is Google's "unusual traffic" / CAPTCHA interstitial
 * (`google.<tld>/sorry/...`), returns the page it was guarding — pulled
 * from the interstitial's own `continue=` query param, which Google always
 * sets to the original request URL — so a retry can go straight back to
 * what the user/browser actually wanted instead of reloading the
 * interstitial itself. Returns null for any other URL.
 */
export function extractGoogleBlockContinueUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)) return null;
  if (!parsed.pathname.startsWith('/sorry/')) return null;
  const continueParam = parsed.searchParams.get('continue');
  return continueParam || url;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export declare interface BrowserManager {
  on(event: 'stateChanged', listener: (state: BrowserState) => void): this;
  emit(event: 'stateChanged', state: BrowserState): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export class BrowserManager extends EventEmitter {
  private browsers = new Map<number, ManagedBrowser>();
  private window: BrowserWindow | null = null;
  private activeId: number | null = null;
  private globalLoginHandlerInstalled = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private keepAliveIntervalMs = 60_000;
  private keepAliveMaxHops = 25;
  private keepAliveFollowLinks = true;

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.installGlobalLoginHandler();
  }

  /**
   * Installed exactly once per app lifetime (see class doc above). Routes
   * each proxy-auth challenge to the specific managed browser whose
   * WebContents triggered it, using that browser's own assigned proxy
   * credentials — never a different browser's.
   */
  private installGlobalLoginHandler(): void {
    if (this.globalLoginHandlerInstalled) return;
    this.globalLoginHandlerInstalled = true;

    app.on('login', (event, webContents, _details, authInfo, callback) => {
      if (!authInfo.isProxy) return; // let page-level basic-auth challenges use Electron's default handling

      const managed = Array.from(this.browsers.values()).find((m) => m.view.webContents.id === webContents.id);
      const proxy = managed?.state.proxy;

      if (proxy?.username) {
        event.preventDefault();
        callback(proxy.username, proxy.password);
      } else {
        // No credentials configured for this browser's proxy — let Electron
        // fall through to its default (cancel) behavior rather than hanging.
      }
    });
  }

  private partitionFor(id: number, _persist: boolean): string {
    // Browser site data is always session-only. A new process gets a fresh
    // in-memory partition regardless of the legacy persistSessions setting.
    return `${EPHEMERAL_PARTITION_PREFIX}${id}-${process.pid}`;
  }

  private async clearLegacyPersistentPartition(id: number): Promise<void> {
    const legacy = session.fromPartition(`${PARTITION_PREFIX}${id}`, { cache: true });
    await Promise.allSettled([legacy.clearStorageData(), legacy.clearCache()]);
  }

  async purgeLegacyPersistentSessions(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.clearLegacyPersistentPartition(id);
    }
  }

  async createBrowser(id: number, options: BrowserManagerOptions): Promise<void> {
    if (this.browsers.has(id)) return;

    // Remove cookies/cache/local storage left by older persistent builds
    // before creating this run's in-memory browser.
    await this.clearLegacyPersistentPartition(id);

    const partition = this.partitionFor(id, options.persistSessions);
    const ses = session.fromPartition(partition, { cache: true });
    if (options.userAgent) ses.setUserAgent(options.userAgent);

    const view = new BrowserView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });

    const state: BrowserState = {
      id,
      label: `Browser ${id}`,
      url: normalizeUrl(options.startPage),
      loading: false,
      canGoBack: false,
      canGoForward: false,
      proxy: null,
      connectionStatus: 'idle',
      crashCount: 0,
      keepAliveEnabled: false,
      keepAliveHops: 0
    };

    const managed: ManagedBrowser = {
      id,
      view,
      session: ses,
      state,
      restartAttempts: 0,
      googleBlockRetries: 0,
      keepAliveEnabled: false,
      keepAliveHops: 0,
      keepAliveNextAt: Date.now() + this.keepAliveIntervalMs,
      keepAliveBusy: false,
      keepAliveVisited: new Set<string>()
    };
    this.browsers.set(id, managed);
    this.wireEvents(managed, options);

    this.window?.addBrowserView(view);
    const startUrl = normalizeUrl(options.startPage);
    await view.webContents.loadURL(startUrl).catch((err) => {
      logger.warn('browser', `Browser ${id} failed initial load: ${(err as Error).message}`);
      this.updateState(managed, { connectionStatus: 'proxy-failed', errorMessage: (err as Error).message });
    });
  }

  private wireEvents(managed: ManagedBrowser, options: BrowserManagerOptions): void {
    const { view, id } = managed;
    const wc = view.webContents;

    wc.on('did-start-loading', () => this.updateState(managed, { loading: true, connectionStatus: 'loading' }));
    wc.on('did-stop-loading', () =>
      this.updateState(managed, {
        loading: false,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        connectionStatus: 'connected'
      })
    );
    wc.on('did-navigate', (_e, url) => {
      this.updateState(managed, { url });
      this.maybeHandleGoogleBlock(managed, url, options);
    });
    wc.on('did-navigate-in-page', (_e, url) => this.updateState(managed, { url }));
    wc.on('page-title-updated', (_e, title) => this.updateState(managed, { title }));
    wc.on('page-favicon-updated', (_e, favicons) =>
      this.updateState(managed, { faviconUrl: favicons[0] })
    );
    wc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED (e.g. user navigated away mid-load)
      this.updateState(managed, {
        loading: false,
        connectionStatus: managed.state.proxy ? 'proxy-failed' : 'no-proxy',
        errorMessage: errorDescription
      });
      logger.warn('browser', `Browser ${id} failed to load: ${errorDescription} (${errorCode})`);
    });

    wc.on('render-process-gone', (_e, details) => {
      logger.error('browser', `Browser ${id} renderer process gone: ${details.reason}`);
      this.updateState(managed, { connectionStatus: 'crashed', crashCount: managed.state.crashCount + 1 });
      void this.handleCrash(managed, options);
    });

    // Never let a link, target="_blank", or window.open() spawn a real new
    // OS-level window. A window created that way would NOT be one of our
    // managed BrowserViews — it would have no assigned proxy, no session
    // isolation, and no entry in this app's UI at all, making it both
    // untraceable from here and a proxy/anonymity leak (traffic from it
    // goes out directly, not through this browser's proxy). Instead, open
    // the link in this same browser/session. `did-create-window` is a
    // defensive backstop in case some other path still manages to create
    // one despite the deny below.
    wc.setWindowOpenHandler(({ url }) => {
      logger.info('browser', `Browser ${id}: opening "${url}" in place instead of a new window.`);
      void wc.loadURL(url).catch((err) => {
        logger.warn('browser', `Browser ${id} failed to open in-place link ${url}: ${(err as Error).message}`);
      });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (win) => {
      logger.warn('browser', `Browser ${id}: a new window was created despite the deny handler — closing it.`);
      try {
        win.close();
      } catch {
        // Already gone — nothing to do.
      }
    });
  }

  private async handleCrash(managed: ManagedBrowser, options: BrowserManagerOptions): Promise<void> {
    if (managed.restartAttempts >= 3) {
      logger.error('browser', `Browser ${managed.id} exceeded max restart attempts (3). Awaiting manual restart.`);
      return;
    }
    managed.restartAttempts += 1;
    const lastUrl = managed.state.url;
    logger.info('browser', `Restarting Browser ${managed.id} (attempt ${managed.restartAttempts}/3).`);
    try {
      await managed.view.webContents.loadURL(normalizeUrl(lastUrl || options.startPage));
      this.updateState(managed, { connectionStatus: 'connected' });
    } catch (err) {
      logger.warn('browser', `Browser ${managed.id} restart attempt failed: ${(err as Error).message}`);
    }
  }

  /**
   * Called on every navigation. If the URL just landed on is Google's
   * CAPTCHA interstitial, records it as a failure on this browser (so the
   * UI shows *why* nothing loaded, instead of it just looking stuck) and,
   * while still under MAX_GOOGLE_BLOCK_RETRIES, notifies the caller so it
   * can swap in a different proxy and retry the real page — see
   * BrowserManagerOptions.onGoogleBlocked. A normal page load (anything
   * that isn't the interstitial) resets the counter, so retries are
   * counted per unbroken streak of blocks, not cumulatively for the
   * browser's whole lifetime.
   */
  private maybeHandleGoogleBlock(managed: ManagedBrowser, url: string, options: BrowserManagerOptions): void {
    const continueUrl = extractGoogleBlockContinueUrl(url);
    if (!continueUrl) {
      managed.googleBlockRetries = 0;
      return;
    }

    if (managed.googleBlockRetries >= MAX_GOOGLE_BLOCK_RETRIES) {
      this.updateState(managed, {
        connectionStatus: 'proxy-failed',
        errorMessage: `Blocked by Google (CAPTCHA) — gave up after ${MAX_GOOGLE_BLOCK_RETRIES} automatic proxy retries. Use "Change Proxy" to try another manually.`
      });
      logger.warn(
        'browser',
        `Browser ${managed.id}: exhausted ${MAX_GOOGLE_BLOCK_RETRIES} automatic proxy retries after repeated Google CAPTCHA blocks.`
      );
      return;
    }

    this.updateState(managed, {
      connectionStatus: 'proxy-failed',
      errorMessage: 'Blocked by Google (CAPTCHA) on this proxy — retrying automatically with a different one…'
    });
    managed.googleBlockRetries += 1;
    logger.warn(
      'browser',
      `Browser ${managed.id}: hit Google's CAPTCHA page (attempt ${managed.googleBlockRetries}/${MAX_GOOGLE_BLOCK_RETRIES}) — requesting a proxy swap.`
    );
    options.onGoogleBlocked?.(managed.id, continueUrl);
  }

  private updateState(managed: ManagedBrowser, patch: Partial<BrowserState>): void {
    managed.state = { ...managed.state, ...patch };
    this.emit('stateChanged', managed.state);
  }

  getAll(): BrowserState[] {
    return Array.from(this.browsers.values())
      .sort((a, b) => a.id - b.id)
      .map((m) => m.state);
  }

  private get(id: number): ManagedBrowser {
    const managed = this.browsers.get(id);
    if (!managed) throw new Error(`Unknown browser id: ${id}`);
    return managed;
  }

  async navigate(id: number, url: string): Promise<void> {
    const managed = this.get(id);
    managed.googleBlockRetries = 0;
    const normalized = normalizeUrl(url);
    await managed.view.webContents.loadURL(normalized);
  }

  async reload(id: number): Promise<void> {
    this.get(id).view.webContents.reload();
  }

  async stop(id: number): Promise<void> {
    this.get(id).view.webContents.stop();
  }

  async goBack(id: number): Promise<void> {
    const wc = this.get(id).view.webContents;
    if (wc.canGoBack()) wc.goBack();
  }

  async goForward(id: number): Promise<void> {
    const wc = this.get(id).view.webContents;
    if (wc.canGoForward()) wc.goForward();
  }

  async reloadAll(): Promise<void> {
    for (const managed of this.browsers.values()) managed.view.webContents.reload();
  }

  async stopAll(): Promise<void> {
    for (const managed of this.browsers.values()) managed.view.webContents.stop();
  }

  async clearCookies(id: number): Promise<void> {
    await this.get(id).session.clearStorageData({ storages: ['cookies'] });
  }

  async clearCache(id: number): Promise<void> {
    await this.get(id).session.clearCache();
  }

  async openDevTools(id: number): Promise<void> {
    const wc = this.get(id).view.webContents;
    if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
  }

  async restart(id: number): Promise<void> {
    const managed = this.get(id);
    managed.restartAttempts = 0;
    managed.view.webContents.reload();
  }

  setBounds(id: number, bounds: BrowserBounds): void {
    this.get(id).view.setBounds(bounds);
  }

  setActive(id: number): void {
    this.activeId = id;
  }

  getActive(): number | null {
    return this.activeId;
  }

  /**
   * Assigns a proxy to a browser's isolated session and reloads it so the
   * new routing takes effect. `proxyRules` uses a scheme-agnostic rule
   * (e.g. "socks5://host:port") so every request from this session — not
   * just http(s) — is routed through the assigned proxy.
   */
  async assignProxy(id: number, proxy: ProxyRecord | null): Promise<void> {
    const managed = this.get(id);
    this.updateState(managed, { proxy, connectionStatus: proxy ? 'proxy-checking' : 'no-proxy' });

    if (!proxy) {
      await managed.session.setProxy({ mode: 'direct' });
      return;
    }

    const scheme = proxy.protocol === 'https' ? 'https' : proxy.protocol;
    await managed.session.setProxy({
      proxyRules: `${scheme}://${proxy.host}:${proxy.port}`,
      proxyBypassRules: '<local>'
    });

    try {
      await managed.view.webContents.reload();
    } catch (err) {
      logger.warn('browser', `Browser ${id} failed to reload after proxy change: ${(err as Error).message}`);
    }
  }

  async checkIp(id: number, ipCheckUrl: string): Promise<{ ip?: string; error?: string }> {
    const managed = this.get(id);
    try {
      const result = (await managed.view.webContents.executeJavaScript(
        `fetch(${JSON.stringify(ipCheckUrl)}).then(r => r.json()).then(j => j.ip ?? null).catch(() => null)`
      )) as string | null;
      return { ip: result ?? undefined };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /**
   * Runs one browser's search-and-open workflow: load a Google results
   * page for `query`, scan the organic results for one whose title or
   * surrounding text contains `matchText`, and if found, navigate that
   * browser to it. Used to fan the same (or a per-browser) search out
   * across every workspace from one central command — each browser uses
   * its own assigned proxy, so this naturally surfaces region-specific
   * results too.
   *
   * This reads the results page's DOM once and never clicks anything
   * automatically beyond the single matched link — it does not click
   * through multiple results, does not repeat searches, and leaves the
   * browser exactly where a person doing the same search by hand would
   * end up. Google's result markup changes over time and this browser's
   * proxy may get an interstitial ("unusual traffic") page instead of
   * results — both are reported back as a distinct status rather than
   * silently failing or guessing.
   */
  async broadcastSearch(
    id: number,
    query: string,
    targetWebsite: string,
    maxPages = 5
  ): Promise<BroadcastSearchResult> {
    const managed = this.get(id);
    const wc = managed.view.webContents;
    const ranAt = new Date().toISOString();
    const targetHost = normalizeTargetHost(targetWebsite);

    if (!targetHost) {
      return { browserId: id, status: 'error', error: 'Enter a valid target website or domain.', ranAt };
    }

    const pagesToScan = Math.max(1, Math.min(10, Math.floor(maxPages || 1)));
    let totalScanned = 0;
    let lastSearchUrl = '';

    for (let pageIndex = 0; pageIndex < pagesToScan; pageIndex += 1) {
      const searchUrl = buildGoogleSearchUrl(query, pageIndex);
      lastSearchUrl = searchUrl;

      // IMPORTANT: do not await loadURL here. Electron resolves loadURL only
      // after navigation finishes, but Google results can already be visible
      // and clickable long before images/scripts/other resources finish.
      // Start navigation and scan the newly committed Google DOM in parallel.
      let navigationErrorMessage: string | null = null;
      void wc.loadURL(searchUrl).catch((err) => {
        const message = (err as Error).message || String(err);
        // Clicking a result while Google is still loading intentionally
        // aborts the original search navigation. That is a success path.
        if (!/ERR_ABORTED|-3/i.test(message)) navigationErrorMessage = message;
      });

      const scanDeadline = Date.now() + 12_000;
      let latestScan: GoogleResultScan = { blocked: false, ready: false, resultsScanned: 0 };
      let pageMaxScanned = 0;
      let googleCommitted = false;

      while (Date.now() < scanDeadline) {
        const currentUrl = wc.getURL();

        // The URL commits before the full page finishes loading. As soon as
        // that happens we can inspect Google's progressively-rendered DOM.
        if (extractGoogleBlockContinueUrl(currentUrl)) {
          return {
            browserId: id,
            status: 'blocked',
            landedUrl: currentUrl,
            resultsScanned: totalScanned + pageMaxScanned,
            ranAt
          };
        }

        if (!isGoogleSearchResultsUrl(currentUrl)) {
          // During the short handoff from the previous document to Google,
          // executeJavaScript would still address the old/destroyed world.
          // Wait only a few milliseconds for the search URL to commit.
          if (navigationErrorMessage) {
            return {
              browserId: id,
              status: 'error',
              error: `Failed to load Google results page ${pageIndex + 1}: ${navigationErrorMessage}`,
              ranAt
            };
          }
          await delay(75);
          continue;
        }

        googleCommitted = true;
        try {
          latestScan = (await wc.executeJavaScript(buildGoogleResultScanScript(targetHost))) as GoogleResultScan;
        } catch {
          // Chromium may replace the document between navigation commit and
          // the first rendered result. This is transient, not a failed SEO
          // run. Retry aggressively until result anchors become available.
          await delay(80);
          continue;
        }

        if (latestScan.blocked) {
          return {
            browserId: id,
            status: 'blocked',
            landedUrl: wc.getURL(),
            resultsScanned: totalScanned + pageMaxScanned,
            ranAt
          };
        }

        pageMaxScanned = Math.max(pageMaxScanned, latestScan.resultsScanned);
        if (latestScan.match) break;

        // Once any result markup exists, check essentially in real time.
        // Do not wait for document.readyState === complete.
        await delay(latestScan.ready ? 100 : 80);
      }

      if (!googleCommitted && navigationErrorMessage) {
        return {
          browserId: id,
          status: 'error',
          error: `Failed to load Google results page ${pageIndex + 1}: ${navigationErrorMessage}`,
          ranAt
        };
      }

      totalScanned += pageMaxScanned;
      if (!latestScan.match) continue;

      let clicked = false;
      const point = latestScan.match.clickPoint;
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        // Send a native Chromium mouse gesture directly to the BrowserView.
        // This does not depend on Google's JS click handlers accepting a
        // synthetic HTMLElement.click() and works with separately-rendered
        // domain/title markup like the current desktop SERP.
        const x = Math.max(1, Math.round(point.x));
        const y = Math.max(1, Math.round(point.y));
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        clicked = true;
      }

      // DOM click is retained only as a fallback for unusual layouts where
      // the target is detectable but Chromium does not expose a usable rect.
      if (!clicked) {
        clicked = (await wc
          .executeJavaScript(buildClickGoogleTargetResultScript(targetHost), true)
          .catch(() => false)) as boolean;
      }

      if (!clicked) {
        return {
          browserId: id,
          status: 'error',
          error: `Found "${latestScan.match.title}" on Google page ${pageIndex + 1}, but could not click it.`,
          landedUrl: wc.getURL(),
          resultsScanned: totalScanned,
          ranAt
        };
      }

      const deadline = Date.now() + 15_000;
      let landedUrl = wc.getURL();
      while (Date.now() < deadline) {
        await delay(200);
        landedUrl = wc.getURL();
        if (hostMatchesTarget(landedUrl, targetHost)) break;
      }

      if (!hostMatchesTarget(landedUrl, targetHost)) {
        return {
          browserId: id,
          status: 'error',
          error: `Google result was clicked, but the browser did not land on ${targetHost} within 15 seconds.`,
          landedUrl,
          matchedTitle: latestScan.match.title,
          resultsScanned: totalScanned,
          position: pageIndex * 10 + latestScan.match.organicIndex + 1,
          resultPage: pageIndex + 1,
          ranAt
        };
      }

      this.setBrowserKeepAlive(id, true, true);
      return {
        browserId: id,
        status: 'matched',
        landedUrl,
        matchedTitle: latestScan.match.title,
        resultsScanned: totalScanned,
        position: pageIndex * 10 + latestScan.match.organicIndex + 1,
        resultPage: pageIndex + 1,
        keepAliveStarted: true,
        ranAt
      };
    }

    return {
      browserId: id,
      status: 'no-match',
      landedUrl: lastSearchUrl || wc.getURL(),
      resultsScanned: totalScanned,
      ranAt
    };
  }

  async destroyBrowser(id: number): Promise<void> {
    const managed = this.browsers.get(id);
    if (!managed) return;

    // Explicitly clear runtime browser data before disposal. The partition
    // is already non-persistent, so this is defense in depth for clean exit.
    await Promise.allSettled([
      managed.session.clearStorageData(),
      managed.session.clearCache(),
      managed.session.setProxy({ mode: 'direct' })
    ]);

    this.window?.removeBrowserView(managed.view);
    // @ts-expect-error — destroy() exists on the underlying WebContents at runtime
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.destroy?.();
    this.browsers.delete(id);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(Array.from(this.browsers.keys()).map((id) => this.destroyBrowser(id)));
  }

  copyToClipboard(text: string): void {
    clipboard.writeText(text);
  }

  private ensureKeepAliveTimer(): void {
    if (this.keepAliveTimer) return;
    // Keep the driver independent from bootstrap timing. Individual browser
    // buttons can therefore start Keep Alive even during late initialization.
    this.keepAliveTimer = setInterval(() => this.tickKeepAlive(), 500);
  }

  configureKeepAlive(intervalMs: number, maxHops: number, _followLinks: boolean): void {
    this.keepAliveIntervalMs = Math.max(5_000, Math.min(3_600_000, Math.floor(intervalMs || 60_000)));
    // This central value is the maximum number of content pages processed
    // by each Keep Alive run, including the initial landing page.
    this.keepAliveMaxHops = Math.max(1, Math.min(1000, Math.floor(maxHops || 1)));
    // Enhanced Keep Alive always follows eligible same-site content after
    // completing the full-page scroll cycles, as requested.
    this.keepAliveFollowLinks = true;
    this.ensureKeepAliveTimer();
  }

  setKeepAlive(enabled: boolean, intervalMs: number): void {
    this.configureKeepAlive(intervalMs, this.keepAliveMaxHops, this.keepAliveFollowLinks);
    this.setKeepAliveAll(enabled, enabled);
  }

  setBrowserKeepAlive(id: number, enabled: boolean, resetHops = false): void {
    this.ensureKeepAliveTimer();
    const managed = this.get(id);
    managed.keepAliveEnabled = enabled;
    if (resetHops) {
      managed.keepAliveHops = 0;
      managed.keepAliveVisited.clear();
      const currentUrl = managed.view.webContents.getURL();
      if (currentUrl) managed.keepAliveVisited.add(currentUrl);
    }
    managed.keepAliveNextAt = enabled ? Date.now() : Number.POSITIVE_INFINITY;
    this.updateState(managed, {
      keepAliveEnabled: enabled,
      keepAliveHops: managed.keepAliveHops
    });
    if (enabled) queueMicrotask(() => this.tickKeepAlive());
  }

  setKeepAliveAll(enabled: boolean, resetHops = false): void {
    this.ensureKeepAliveTimer();
    for (const managed of this.browsers.values()) {
      managed.keepAliveEnabled = enabled;
      if (resetHops) {
        managed.keepAliveHops = 0;
        managed.keepAliveVisited.clear();
        const currentUrl = managed.view.webContents.getURL();
        if (currentUrl) managed.keepAliveVisited.add(currentUrl);
      }
      managed.keepAliveNextAt = enabled ? Date.now() : Number.POSITIVE_INFINITY;
      this.updateState(managed, {
        keepAliveEnabled: enabled,
        keepAliveHops: managed.keepAliveHops
      });
    }
    if (enabled) queueMicrotask(() => this.tickKeepAlive());
  }

  private tickKeepAlive(): void {
    const now = Date.now();
    for (const managed of this.browsers.values()) {
      if (!managed.keepAliveEnabled || managed.keepAliveBusy || now < managed.keepAliveNextAt) continue;

      const wc = managed.view.webContents;
      // Query Chromium directly instead of trusting a renderer-facing
      // loading flag that can remain stale after an aborted navigation.
      if (wc.isDestroyed() || wc.isLoading()) {
        managed.keepAliveNextAt = now + 750;
        continue;
      }

      managed.keepAliveBusy = true;
      void this.runKeepAliveAction(managed).finally(() => {
        managed.keepAliveBusy = false;
        // Preserve a short retry explicitly scheduled by the action's error
        // handler; otherwise use the normal jittered content-page interval.
        if (managed.keepAliveNextAt <= Date.now()) {
          const jitter = 0.8 + Math.random() * 0.4;
          managed.keepAliveNextAt = Date.now() + Math.round(this.keepAliveIntervalMs * jitter);
        }
      });
    }
  }

  private async runKeepAliveAction(managed: ManagedBrowser): Promise<void> {
    const wc = managed.view.webContents;
    const pagesVisited = managed.keepAliveHops + 1;
    const canHop = this.keepAliveFollowLinks && pagesVisited < this.keepAliveMaxHops;

    try {
      const result = (await wc.executeJavaScript(buildKeepAliveActionScript(canHop), true)) as {
        links?: string[];
      };

      const completedAt = new Date().toISOString();

      // The current page has now completed its 6–8 full slow down/up cycles.
      // If the central page limit is reached, stop this browser's run.
      if (pagesVisited >= this.keepAliveMaxHops) {
        managed.keepAliveEnabled = false;
        this.updateState(managed, {
          lastKeepAliveAt: completedAt,
          keepAliveEnabled: false,
          keepAliveHops: managed.keepAliveHops
        });
        return;
      }

      const candidates = (result.links ?? []).filter((url) => !managed.keepAliveVisited.has(url));
      if (!canHop || candidates.length === 0) {
        managed.keepAliveEnabled = false;
        this.updateState(managed, {
          lastKeepAliveAt: completedAt,
          keepAliveEnabled: false,
          keepAliveHops: managed.keepAliveHops
        });
        return;
      }

      const nextUrl = candidates[Math.floor(Math.random() * candidates.length)];
      managed.keepAliveVisited.add(nextUrl);
      await wc.loadURL(nextUrl);
      managed.keepAliveHops += 1;
      this.updateState(managed, {
        keepAliveEnabled: true,
        keepAliveHops: managed.keepAliveHops,
        lastKeepAliveAt: completedAt
      });
    } catch (err) {
      // A navigation can make script execution temporarily unavailable.
      // Retry, but record the reason instead of silently doing nothing.
      logger.warn(
        'browser',
        `Browser ${managed.id}: Keep Alive action failed: ${(err as Error).message}`
      );
      managed.keepAliveNextAt = Date.now() + 1500;
    }
  }
}

export function buildKeepAliveActionScript(allowHop: boolean): string {
  return `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.scrollingElement || document.documentElement || document.body;
    const pageHeight = () => Math.max(
      root ? root.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    const maxScroll = () => Math.max(0, pageHeight() - window.innerHeight);

    const animateScrollTo = (target, duration) =>
      new Promise((resolve) => {
        const startY = window.scrollY;
        const delta = target - startY;
        if (Math.abs(delta) < 2) {
          window.scrollTo(0, target);
          resolve();
          return;
        }

        const started = performance.now();
        function frame(now) {
          const t = Math.min(1, (now - started) / duration);
          const eased = t < 0.5
            ? 2 * t * t
            : 1 - Math.pow(-2 * t + 2, 2) / 2;
          window.scrollTo(0, startY + delta * eased);
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });

    const cycles = 6 + Math.floor(Math.random() * 3); // 6, 7 or 8
    if (maxScroll() > 0) {
      // Immediate visible feedback, then the requested full cycles.
      window.scrollTo(0, Math.min(180, maxScroll()));
      await wait(140);
      window.scrollTo(0, 0);
      await wait(180);
      await animateScrollTo(0, 700);
      await wait(250);

      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const downDuration = 3400 + Math.floor(Math.random() * 1600);
        const upDuration = 3400 + Math.floor(Math.random() * 1600);
        await animateScrollTo(maxScroll(), downDuration);
        await wait(550 + Math.floor(Math.random() * 650));
        await animateScrollTo(0, upDuration);
        await wait(550 + Math.floor(Math.random() * 650));
      }
    } else {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        window.scrollBy(0, 1);
        await wait(350);
        window.scrollBy(0, -1);
        await wait(350);
      }
    }

    if (!${allowHop ? 'true' : 'false'}) return { links: [] };

    const blocked = /(login|log-in|logout|sign-in|signin|signup|register|account|cart|basket|checkout|payment|subscribe|privacy|terms|contact|download|delete|remove|admin|wp-admin|wp-login)/i;
    const currentUrl = new URL(location.href);
    const currentHost = currentUrl.hostname.toLowerCase().replace(/^www\\./, '');
    const seen = {};
    const links = [];

    Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
      try {
        if (anchor.hasAttribute('download')) return;
        const rel = (anchor.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('sponsored') || rel.includes('nofollow sponsored')) return;

        const text = (anchor.textContent || '').trim();
        if (text.length < 5 || blocked.test(text)) return;

        const url = new URL(anchor.href, location.href);
        if (!/^https?:$/.test(url.protocol)) return;

        const host = url.hostname.toLowerCase().replace(/^www\\./, '');
        if (host !== currentHost) return;
        if (url.href === currentUrl.href || blocked.test(url.pathname + url.search)) return;

        const rect = anchor.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        url.hash = '';
        const normalized = url.href;
        if (seen[normalized]) return;
        seen[normalized] = true;
        links.push(normalized);
      } catch (_) {
        // Ignore malformed/non-web anchors.
      }
    });

    return { links: links.slice(0, 100) };
  })()`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGoogleSearchResultsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

interface GoogleResultScan {
  blocked: boolean;
  ready: boolean;
  resultsScanned: number;
  match?: {
    url: string;
    title: string;
    organicIndex: number;
    clickPoint?: { x: number; y: number };
  };
}

interface GoogleAutoClickState {
  status: 'watching' | 'blocked' | 'clicked';
  url?: string;
  title?: string;
  organicIndex?: number;
  clickPoint?: { x: number; y: number };
}

export function buildGoogleAutoClickStateScript(): string {
  return `(function() {
    var state = window.__proxydeskSeoAutoClick;
    if (!state) return null;
    return {
      status: state.status,
      url: state.url || undefined,
      title: state.title || undefined,
      organicIndex: typeof state.organicIndex === 'number' ? state.organicIndex : undefined,
      clickPoint: state.clickPoint || undefined
    };
  })()`;
}

export function buildGoogleAutoClickInstallerScript(targetHost: string): string {
  return `(function() {
    var target = ${JSON.stringify(targetHost.toLowerCase())};
    var displayMentionsTarget = ${resultTextMentionsHost.toString()};
    var previous = window.__proxydeskSeoAutoClick;
    if (previous && previous.observer && previous.observer.disconnect) previous.observer.disconnect();
    if (previous && previous.timer) clearInterval(previous.timer);

    var state = {
      status: 'watching',
      url: null,
      title: null,
      organicIndex: null,
      clickPoint: null,
      observer: null,
      timer: null
    };
    window.__proxydeskSeoAutoClick = state;

    function normalizeHost(host) {
      return String(host || '').toLowerCase().replace(/^www\\./, '').replace(/\\.$/, '');
    }

    function unwrap(href) {
      try {
        var resolved = new URL(href, location.href);
        var googleHost = /(^|\\.)google\\.[a-z.]+$/i.test(resolved.hostname);
        if (googleHost && resolved.pathname === '/url') {
          return resolved.searchParams.get('url') || resolved.searchParams.get('q') || href;
        }
        return resolved.href;
      } catch (_) {
        return href;
      }
    }

    function destinationMatches(url) {
      try {
        var host = normalizeHost(new URL(url, location.href).hostname);
        if (host === target || host.endsWith('.' + target)) return true;
        if (target.indexOf('.') === -1 && host.split('.').indexOf(target) !== -1) return true;
        return false;
      } catch (_) {
        return false;
      }
    }

    function isVisible(node) {
      if (!node || !node.getBoundingClientRect) return false;
      var r = node.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && r.bottom >= 0 && r.right >= 0 &&
        r.top <= window.innerHeight && r.left <= window.innerWidth;
    }

    function cardFor(anchor) {
      if (!anchor) return null;
      var direct = anchor.closest && anchor.closest('.MjjYud, .g, [data-snhf], [data-hveid]');
      if (direct) return direct;
      var current = anchor;
      for (var depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        var text = ((current && current.innerText) || '').slice(0, 2200);
        if (displayMentionsTarget(text, target)) return current;
      }
      return anchor.parentElement || anchor;
    }

    function stopWatching() {
      if (state.observer && state.observer.disconnect) state.observer.disconnect();
      if (state.timer) clearInterval(state.timer);
      state.observer = null;
      state.timer = null;
    }

    function scanAndClick() {
      try {
        if (/\\/sorry\\/|consent\\.google\\./.test(location.href)) {
          state.status = 'blocked';
          stopWatching();
          return true;
        }
        var bodyText = (document.body && document.body.innerText) || '';
        if (/unusual traffic|not a robot|recaptcha/i.test(bodyText.slice(0, 3500))) {
          state.status = 'blocked';
          stopWatching();
          return true;
        }

        var root = document.querySelector('#search') || document.querySelector('#rso') || document.querySelector('main') || document.body;
        if (!root || !root.querySelectorAll) return false;
        var anchors = Array.prototype.slice.call(root.querySelectorAll('a[href]'));
        var candidates = [];

        for (var i = 0; i < anchors.length; i += 1) {
          var anchor = anchors[i];
          if (!isVisible(anchor)) continue;
          var destination = unwrap(anchor.getAttribute('href') || anchor.href || '');
          var card = cardFor(anchor);
          var cardText = ((card && card.innerText) || anchor.innerText || '').slice(0, 2200);
          if (/\\bSponsored\\b/i.test(cardText.slice(0, 260))) continue;
          var direct = destinationMatches(destination);
          var cardMatch = displayMentionsTarget(cardText, target);
          if (!direct && !cardMatch) continue;

          var text = (anchor.innerText || anchor.getAttribute('aria-label') || '').trim();
          var heading = anchor.querySelector && anchor.querySelector('h3');
          var score = 0;
          if (heading) score += 120;
          if (direct) score += 60;
          if (text.length >= 18 && !displayMentionsTarget(text, target)) score += 45;
          try {
            var parsed = new URL(destination, location.href);
            if (direct && parsed.pathname && parsed.pathname !== '/') score += 40;
          } catch (_) {}
          candidates.push({ anchor: anchor, destination: destination, score: score, index: i, title: ((heading && heading.innerText) || text).trim() });
        }

        if (!candidates.length) return false;
        candidates.sort(function(a, b) { return b.score - a.score; });
        var chosen = candidates[0];
        var rect = chosen.anchor.getBoundingClientRect();
        state.status = 'clicked';
        state.url = chosen.destination;
        state.title = chosen.title;
        state.organicIndex = chosen.index;
        state.clickPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        stopWatching();

        try { chosen.anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (_) {}
        try { chosen.anchor.target = '_self'; } catch (_) {}
        try { chosen.anchor.focus({ preventScroll: true }); } catch (_) {}
        try { chosen.anchor.click(); } catch (_) {}

        // Hard fallback: only after the actual Google result anchor has been
        // identified and clicked. If Google's handlers ignore the synthetic
        // click, follow that exact result URL from the SERP shortly after.
        setTimeout(function() {
          try {
            if (/^https?:\\/\\/(?:[^.]+\\.)?google\\./i.test(location.href)) {
              location.assign(chosen.destination);
            }
          } catch (_) {}
        }, 300);
        return true;
      } catch (_) {
        return false;
      }
    }

    if (!scanAndClick()) {
      var observeRoot = document.documentElement || document.body;
      if (observeRoot && typeof MutationObserver !== 'undefined') {
        state.observer = new MutationObserver(function() { scanAndClick(); });
        state.observer.observe(observeRoot, { childList: true, subtree: true, characterData: true });
      }
      state.timer = setInterval(scanAndClick, 75);
    }

    return { status: state.status, url: state.url, title: state.title, organicIndex: state.organicIndex, clickPoint: state.clickPoint };
  })()`;
}

export function buildGoogleResultScanScript(targetHost: string): string {
  return `(function() {
    try {
      var target = ${JSON.stringify(targetHost.toLowerCase())};
      var loc = window.location.href;
      if (/\\/sorry\\/|consent\\.google\\./.test(loc)) {
        return { blocked: true, ready: true, resultsScanned: 0 };
      }

      var bodyText = (document.body && document.body.innerText) || '';
      if (/unusual traffic|not a robot|recaptcha/i.test(bodyText.slice(0, 2500))) {
        return { blocked: true, ready: true, resultsScanned: 0 };
      }

      function unwrap(href) {
        try {
          var resolved = new URL(href, location.href);
          var googleHost = /(^|\\.)google\\.[a-z.]+$/i.test(resolved.hostname);
          if (googleHost && resolved.pathname === '/url') {
            return resolved.searchParams.get('url') || resolved.searchParams.get('q') || href;
          }
          return resolved.href;
        } catch (_) {
          return href;
        }
      }

      function normalizeHost(host) {
        return String(host || '').toLowerCase().replace(/^www\\./, '').replace(/\\.$/, '');
      }

      function destinationMatches(url) {
        try {
          var host = normalizeHost(new URL(url, location.href).hostname);
          return host === target || host.endsWith('.' + target);
        } catch (_) {
          return false;
        }
      }

      var displayMentionsTarget = ${resultTextMentionsHost.toString()};
      var searchRoot = document.querySelector('#search') || document.querySelector('#rso') || document.querySelector('main') || document.body;

      function visibleRect(node) {
        if (!node || !node.getBoundingClientRect) return null;
        var rect = node.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2) return null;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return null;
        return rect;
      }

      function resultContainerFor(node) {
        if (!node) return null;
        var direct = node.closest && node.closest('.MjjYud, .g, [data-snhf], [data-hveid]');
        if (direct) return direct;
        var current = node;
        for (var depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          var text = ((current && current.innerText) || '').slice(0, 1800);
          if (displayMentionsTarget(text, target) && current.querySelector && current.querySelector('a[href]')) return current;
        }
        return node.parentElement || node;
      }

      function bestAnchor(container, seedAnchor) {
        var candidates = [];
        if (seedAnchor) candidates.push(seedAnchor);
        if (container && container.querySelectorAll) {
          Array.prototype.slice.call(container.querySelectorAll('a[href]')).forEach(function (a) {
            if (candidates.indexOf(a) === -1) candidates.push(a);
          });
        }
        var best = null;
        var bestScore = -1;
        for (var j = 0; j < candidates.length; j += 1) {
          var a = candidates[j];
          if (!visibleRect(a)) continue;
          var destination = unwrap(a.getAttribute('href') || a.href || '');
          var text = (a.innerText || a.getAttribute('aria-label') || '').trim();
          var hasHeading = Boolean(a.querySelector && a.querySelector('h3'));
          var direct = destinationMatches(destination);
          var score = 0;
          if (hasHeading) score += 100;
          if (direct) score += 40;
          if (text.length >= 18 && !displayMentionsTarget(text, target)) score += 35;
          try {
            var parsedDestination = new URL(destination, location.href);
            if (direct && parsedDestination.pathname && parsedDestination.pathname !== '/') score += 30;
          } catch (_) {
            // Ignore malformed candidate URLs.
          }
          if (a === seedAnchor) score += 1;
          if (score > bestScore) {
            best = a;
            bestScore = score;
          }
        }
        return best;
      }

      var anchors = Array.prototype.slice.call(searchRoot ? searchRoot.querySelectorAll('a[href]') : []);
      var resultsScanned = 0;
      for (var i = 0; i < anchors.length; i += 1) {
        var seed = anchors[i];
        var destination = unwrap(seed.getAttribute('href') || seed.href || '');
        var container = resultContainerFor(seed);
        var nearbyText = ((container && container.innerText) || seed.innerText || '').slice(0, 1800);
        if (/\\bSponsored\\b/i.test(nearbyText.slice(0, 220))) continue;

        var matched = destinationMatches(destination) || displayMentionsTarget(nearbyText, target);
        if (!matched) continue;

        var anchor = bestAnchor(container, seed);
        if (!anchor) continue;
        var anchorDestination = unwrap(anchor.getAttribute('href') || anchor.href || destination);
        var titleNode = anchor.querySelector && anchor.querySelector('h3');
        var titleText = ((titleNode && titleNode.innerText) || anchor.getAttribute('aria-label') || anchor.innerText || '').trim();
        anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        var rect = visibleRect(anchor);
        if (!rect) continue;

        resultsScanned += 1;
        return {
          blocked: false,
          ready: true,
          resultsScanned: resultsScanned,
          match: {
            url: anchorDestination,
            title: titleText,
            organicIndex: resultsScanned - 1,
            clickPoint: {
              x: rect.left + Math.min(rect.width / 2, Math.max(12, rect.width - 12)),
              y: rect.top + rect.height / 2
            }
          }
        };
      }

      // Fallback for Google's current layout where the visible domain line
      // can be a sibling of the blue title rather than text inside its <a>.
      var textNodes = Array.prototype.slice.call(searchRoot ? searchRoot.querySelectorAll('span, cite, div') : []);
      for (var k = 0; k < textNodes.length; k += 1) {
        var node = textNodes[k];
        var nodeText = (node.innerText || '').trim();
        if (!displayMentionsTarget(nodeText, target)) continue;
        var card = resultContainerFor(node);
        var cardText = ((card && card.innerText) || '').slice(0, 1800);
        if (/\\bSponsored\\b/i.test(cardText.slice(0, 220))) continue;
        var fallbackAnchor = bestAnchor(card, node.closest && node.closest('a[href]'));
        if (!fallbackAnchor) continue;
        var fallbackRect = visibleRect(fallbackAnchor);
        if (!fallbackRect) continue;
        var fallbackDestination = unwrap(fallbackAnchor.getAttribute('href') || fallbackAnchor.href || '');
        var fallbackTitleNode = fallbackAnchor.querySelector && fallbackAnchor.querySelector('h3');
        var fallbackTitle = ((fallbackTitleNode && fallbackTitleNode.innerText) || fallbackAnchor.getAttribute('aria-label') || fallbackAnchor.innerText || '').trim();
        fallbackAnchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        fallbackRect = visibleRect(fallbackAnchor) || fallbackRect;
        resultsScanned += 1;
        return {
          blocked: false,
          ready: true,
          resultsScanned: resultsScanned,
          match: {
            url: fallbackDestination,
            title: fallbackTitle,
            organicIndex: resultsScanned - 1,
            clickPoint: {
              x: fallbackRect.left + Math.min(fallbackRect.width / 2, Math.max(12, fallbackRect.width - 12)),
              y: fallbackRect.top + fallbackRect.height / 2
            }
          }
        };
      }

      return {
        blocked: false,
        ready: anchors.length > 0 || document.readyState === 'complete',
        resultsScanned: resultsScanned
      };
    } catch (_) {
      return { blocked: false, ready: false, resultsScanned: 0 };
    }
  })()`;
}

export function buildClickGoogleTargetResultScript(targetHost: string): string {
  return `(function() {
    try {
      var target = ${JSON.stringify(targetHost.toLowerCase())};
      var displayMentionsTarget = ${resultTextMentionsHost.toString()};

      function unwrap(href) {
        try {
          var resolved = new URL(href, location.href);
          var googleHost = /(^|\\.)google\\.[a-z.]+$/i.test(resolved.hostname);
          if (googleHost && resolved.pathname === '/url') {
            return resolved.searchParams.get('url') || resolved.searchParams.get('q') || href;
          }
          return resolved.href;
        } catch (_) {
          return href;
        }
      }

      function normalizeHost(host) {
        return String(host || '').toLowerCase().replace(/^www\\./, '').replace(/\\.$/, '');
      }

      function destinationMatches(url) {
        try {
          var host = normalizeHost(new URL(url, location.href).hostname);
          return host === target || host.endsWith('.' + target);
        } catch (_) {
          return false;
        }
      }

      var searchRoot = document.querySelector('#search') || document.querySelector('#rso') || document.querySelector('main') || document.body;
      var anchors = Array.prototype.slice.call(searchRoot ? searchRoot.querySelectorAll('a[href]') : []);
      for (var i = 0; i < anchors.length; i += 1) {
        var anchor = anchors[i];
        var destination = unwrap(anchor.getAttribute('href') || anchor.href || '');
        var container = anchor.closest('.MjjYud, .g, [data-snhf]') ||
          (anchor.parentElement && anchor.parentElement.parentElement && anchor.parentElement.parentElement.parentElement) ||
          anchor.parentElement || anchor;
        var nearbyText = ((container && container.innerText) || anchor.innerText || '').slice(0, 1200);
        if (/\\bSponsored\\b/i.test(nearbyText.slice(0, 180))) continue;

        var displayText = nearbyText.toLowerCase().replace(/www\\./g, '');
        var directMatch = destinationMatches(destination);
        var textMatch = displayMentionsTarget(displayText, target);
        if (!directMatch && !textMatch) continue;

        // Prefer the actual result-title/citation anchor. A visible target
        // citation is still accepted when Google changes the heading markup.
        if (!anchor.querySelector('h3') && !directMatch && !displayMentionsTarget(anchor.innerText || '', target)) continue;
        anchor.scrollIntoView({ block: 'center', behavior: 'auto' });
        anchor.focus({ preventScroll: true });
        anchor.click();
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  })()`;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?/.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
