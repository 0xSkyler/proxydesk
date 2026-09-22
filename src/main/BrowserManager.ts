import { EventEmitter } from 'node:events';
import { app, BrowserView, BrowserWindow, clipboard, session, type Session } from 'electron';
import type { BroadcastSearchResult, BrowserBounds, BrowserState } from '../shared/types/browser';
import type { ProxyRecord } from '../shared/types/proxy';
import { EPHEMERAL_PARTITION_PREFIX, PARTITION_PREFIX } from '../shared/constants';
import { buildGoogleSearchUrl, normalizeTargetHost, resultTextMentionsHost } from '../shared/seo';
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
  controlledKeepAliveHost: string | null;
  controlledKeepAliveContinuous: boolean;
}

/**
 * If `url` is Google's "unusual traffic" / CAPTCHA interstitial
 * (`google.<tld>/sorry/...`), returns the page it was guarding — pulled
 * from the interstitial's own `continue=` query param, which Google always
 * sets to the original request URL — so a retry can go straight back to
 * what the user/browser actually wanted instead of reloading the
 * interstitial itself. Returns null for any other URL.
 */
export function buildEphemeralPartitionName(id: number, pid = process.pid): string {
  // No "persist:" prefix means Electron keeps the partition in memory only.
  // Browser id prevents sharing inside one run; process id prevents reuse
  // after the app exits and starts again.
  return `${EPHEMERAL_PARTITION_PREFIX}${id}-${pid}`;
}

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
  private measurementTokens = new Map<number, number>();

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
    return buildEphemeralPartitionName(id);
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
    // This partition has no "persist:" prefix, so it exists only in memory.
    // Clear defensively as well: every process launch and every browser id
    // begins with empty cookies/storage/cache.
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache()]);
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
      keepAliveVisited: new Set<string>(),
      controlledKeepAliveHost: null,
      controlledKeepAliveContinuous: false
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
   * Runs one browser's measurement-only Google scan. It loads result pages,
   * watches progressively-rendered organic results, and records a target
   * match without clicking it. Challenge pages are reported as a paused
   * observation so the session monitor can wait for normal results to return.
   *
   * This keeps SEO measurement separate from generated site engagement.
   */
  startMeasurementSession(id: number): number {
    const token = (this.measurementTokens.get(id) ?? 0) + 1;
    this.measurementTokens.set(id, token);
    return token;
  }

  cancelMeasurementSession(id: number): void {
    this.measurementTokens.set(id, (this.measurementTokens.get(id) ?? 0) + 1);
    const managed = this.browsers.get(id);
    if (managed && !managed.view.webContents.isDestroyed()) managed.view.webContents.stop();
  }

  isMeasurementSessionCurrent(id: number, token: number): boolean {
    return this.measurementTokens.get(id) === token;
  }

  async broadcastSearch(
    id: number,
    query: string,
    targetWebsite: string,
    maxPages = 20,
    measurementToken?: number
  ): Promise<BroadcastSearchResult> {
    const managed = this.get(id);
    const wc = managed.view.webContents;
    const ranAt = new Date().toISOString();
    const targetHost = normalizeTargetHost(targetWebsite);

    if (!targetHost) {
      return {
        browserId: id,
        status: 'error',
        error: 'Enter a valid target website or site name.',
        ranAt
      };
    }

    const pagesToScan = Math.max(1, Math.min(100, Math.floor(maxPages || 1)));
    let totalScanned = 0;
    let lastSearchUrl = '';

    /**
     * Start Google navigation and return as soon as its DOM exists.
     * Result detection runs while the page is still rendering; full network
     * completion is never a prerequisite.
     */
    const loadSearchDom = async (url: string): Promise<void> => {
      let ready = false;
      const onDomReady = () => {
        if (isGoogleSearchResultsUrl(wc.getURL())) ready = true;
      };
      wc.on('dom-ready', onDomReady);

      let loadError: string | null = null;
      void wc.loadURL(url).catch((err) => {
        const message = (err as Error).message || String(err);
        if (!/ERR_ABORTED|-3/i.test(message)) loadError = message;
      });

      const deadline = Date.now() + 5_000;
      try {
        while (Date.now() < deadline) {
          const current = wc.getURL();
          if (extractGoogleBlockContinueUrl(current)) return;
          if (ready || isGoogleSearchResultsUrl(current)) {
            // A tiny paint grace is enough to begin text recognition. The
            // scanner below keeps watching as more result blocks arrive.
            await delay(60);
            return;
          }
          if (loadError) break;
          await delay(25);
        }
      } finally {
        wc.removeListener('dom-ready', onDomReady);
      }

      if (loadError && !isGoogleSearchResultsUrl(wc.getURL())) {
        throw new Error(loadError);
      }
    };

    for (let pageIndex = 0; pageIndex < pagesToScan; pageIndex += 1) {
      if (
        measurementToken != null &&
        !this.isMeasurementSessionCurrent(id, measurementToken)
      ) {
        return {
          browserId: id,
          status: 'monitoring',
          landedUrl: wc.getURL(),
          monitoring: true,
          ranAt
        };
      }

      const searchUrl = buildGoogleSearchUrl(query, pageIndex);
      lastSearchUrl = searchUrl;

      try {
        await loadSearchDom(searchUrl);
      } catch (err) {
        return {
          browserId: id,
          status: 'error',
          error: `Failed to open Google result page ${pageIndex + 1}: ${(err as Error).message}`,
          ranAt
        };
      }

      const currentUrl = wc.getURL();
      if (extractGoogleBlockContinueUrl(currentUrl)) {
        return {
          browserId: id,
          status: 'paused',
          landedUrl: currentUrl,
          monitoring: true,
          resultsScanned: totalScanned,
          ranAt
        };
      }

      // After stop(), script execution is no longer queued behind Google's
      // unfinished network load. Keep rescanning this SAME page while the
      // organic result set settles. Never paginate merely because header or
      // footer anchors exist.
      let scan: GoogleResultScan = {
        blocked: false,
        ready: false,
        resultsScanned: 0,
        observedResults: 0,
        signature: ''
      };
      let pageMaxObserved = 0;
      let lastSignature = '';
      let stableScans = 0;
      let zeroReadyScans = 0;
      let firstOrganicAt = 0;
      const firstScanStartedAt = Date.now();
      const scanDeadline = firstScanStartedAt + 5_000;

      while (Date.now() < scanDeadline) {
        if (
          measurementToken != null &&
          !this.isMeasurementSessionCurrent(id, measurementToken)
        ) {
          return {
            browserId: id,
            status: 'monitoring',
            landedUrl: wc.getURL(),
            resultsScanned: totalScanned,
            monitoring: true,
            ranAt
          };
        }

        try {
          const attempt = await Promise.race([
            wc.executeJavaScript(
              buildGoogleResultScanScript(targetHost, query),
              true
            ).then((value) => ({ kind: 'scan' as const, value })),
            delay(250).then(() => ({ kind: 'timeout' as const }))
          ]);

          if (attempt.kind === 'timeout') {
            // Some Electron/Google combinations delay script execution while
            // the navigation is busy. Do not wait for the full page: after a
            // short render window, stop only the remaining resources and
            // continue scanning the DOM that is already visible.
            if (wc.isLoading() && Date.now() - firstScanStartedAt >= 1_800) {
              wc.stop();
              await delay(40);
            } else {
              await delay(60);
            }
            continue;
          }

          scan = attempt.value as GoogleResultScan;
        } catch {
          if (wc.isLoading() && Date.now() - firstScanStartedAt >= 1_800) {
            wc.stop();
            await delay(40);
          } else {
            await delay(80);
          }
          continue;
        }

        if (scan.blocked) {
          return {
            browserId: id,
            status: 'paused',
            landedUrl: wc.getURL(),
            monitoring: true,
            resultsScanned: totalScanned,
            ranAt
          };
        }

        pageMaxObserved = Math.max(pageMaxObserved, scan.observedResults || scan.resultsScanned || 0);

        // A target wins immediately, even if the rest of the page is still
        // rendering.
        if (scan.match) break;

        if (scan.observedResults > 0) {
          if (!firstOrganicAt) firstOrganicAt = Date.now();
          if (scan.signature && scan.signature === lastSignature) {
            stableScans += 1;
          } else {
            lastSignature = scan.signature;
            stableScans = 1;
          }

          // Require several identical snapshots over time before declaring
          // the page a real no-match. This prevents page 1 -> page 20 races.
          if (stableScans >= 6 && Date.now() - firstOrganicAt >= 1_000) break;
        } else if (scan.ready) {
          zeroReadyScans += 1;
          // A genuinely empty/omitted-results page may have no organic links.
          // Still wait multiple scans before moving on.
          if (zeroReadyScans >= 8) break;
        }

        await delay(140);
      }

      totalScanned += pageMaxObserved;
      if (!scan.match) {
        // Only after the current organic result set is stable (or the full
        // scan window expires) is the next Google page allowed.
        if (wc.isLoading()) wc.stop();
        continue;
      }

      return {
        browserId: id,
        status: 'matched',
        landedUrl: wc.getURL(),
        matchedUrl: scan.match.url,
        matchedTitle: scan.match.title,
        resultsScanned: totalScanned,
        position: pageIndex * 10 + scan.match.organicIndex + 1,
        resultPage: pageIndex + 1,
        monitoring: true,
        keepAliveStarted: false,
        ranAt
      };
    }

    return {
      browserId: id,
      status: 'no-match',
      landedUrl: lastSearchUrl || wc.getURL(),
      resultsScanned: totalScanned,
      monitoring: true,
      ranAt
    };
  }

  async waitForGoogleRecovery(id: number, maxWaitMs: number): Promise<boolean> {
    const managed = this.get(id);
    const wc = managed.view.webContents;
    const deadline = Date.now() + Math.max(1_000, maxWaitMs);

    while (Date.now() < deadline) {
      if (wc.isDestroyed()) return false;

      const url = wc.getURL();
      if (isGoogleSearchResultsUrl(url)) {
        try {
          const state = (await Promise.race([
            wc.executeJavaScript(`(function() {
              var text = (document.body && document.body.innerText) || '';
              var blocked =
                /unusual traffic|not a robot|recaptcha|verify you are human/i.test(text.slice(0, 5000)) ||
                /\\/sorry\\/|consent\\.google\\./i.test(location.href);
              var hasResults = Boolean(
                document.querySelector('#search') ||
                document.querySelector('#rso') ||
                document.querySelector('main')
              );
              return { blocked: blocked, hasResults: hasResults };
            })()`, true),
            delay(500).then(() => null)
          ])) as { blocked?: boolean; hasResults?: boolean } | null;

          if (state && !state.blocked && state.hasResults) return true;
        } catch {
          // Navigation may still be replacing the challenge document.
        }
      }

      await delay(1_000);
    }

    return false;
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

  async clickControlledGoogleResult(
    id: number,
    query: string,
    controlledHost: string,
    expectedUrl: string,
    measurementToken: number
  ): Promise<boolean> {
    const managed = this.get(id);
    const wc = managed.view.webContents;
    const normalizedHost = normalizeTargetHost(controlledHost);
    if (!normalizedHost || !this.isMeasurementSessionCurrent(id, measurementToken)) return false;

    try {
      const expectedHost = new URL(expectedUrl).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      if (expectedHost !== normalizedHost) return false;
    } catch {
      return false;
    }

    if (!isGoogleSearchResultsUrl(wc.getURL())) return false;

    try {
      const scan = (await wc.executeJavaScript(
        buildGoogleResultScanScript(normalizedHost, query),
        true
      )) as GoogleResultScan;

      if (!scan.match || !scan.match.url) return false;
      const matchHost = new URL(scan.match.url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      if (matchHost !== normalizedHost) return false;

      const point = scan.match.clickPoint;
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        const x = Math.max(1, Math.round(point.x));
        const y = Math.max(1, Math.round(point.y));
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else {
        const clicked = (await wc.executeJavaScript(
          buildClickGoogleTargetResultScript(normalizedHost, query),
          true
        )) as boolean;
        if (!clicked) return false;
      }

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (!this.isMeasurementSessionCurrent(id, measurementToken)) return false;
        const current = wc.getURL();
        try {
          const host = new URL(current).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
          if (host === normalizedHost) return true;
        } catch {
          // Keep waiting through transient navigation URLs.
        }
        await delay(100);
      }

      // One DOM-level retry is allowed if the native event was ignored.
      if (isGoogleSearchResultsUrl(wc.getURL())) {
        const clicked = (await wc.executeJavaScript(
          buildClickGoogleTargetResultScript(normalizedHost, query),
          true
        ).catch(() => false)) as boolean;

        if (clicked) {
          const retryDeadline = Date.now() + 5_000;
          while (Date.now() < retryDeadline) {
            if (!this.isMeasurementSessionCurrent(id, measurementToken)) return false;
            try {
              const host = new URL(wc.getURL()).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
              if (host === normalizedHost) return true;
            } catch {
              // Navigation is still settling.
            }
            await delay(100);
          }
        }
      }
    } catch (err) {
      logger.warn('browser', `Browser ${id}: controlled test result click failed: ${(err as Error).message}`);
    }

    return false;
  }

  startControlledKeepAlive(id: number, controlledHost: string): void {
    const managed = this.get(id);
    const normalizedHost = normalizeTargetHost(controlledHost);
    if (!normalizedHost) throw new Error('Invalid controlled test host.');

    let currentHost = '';
    try {
      currentHost = new URL(managed.view.webContents.getURL()).hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, '');
    } catch {
      throw new Error('Browser is not on a valid controlled test page.');
    }

    if (currentHost !== normalizedHost) {
      throw new Error(`Controlled Keep Alive requires exact host ${normalizedHost}; browser is on ${currentHost || 'unknown'}.`);
    }

    this.ensureKeepAliveTimer();
    managed.controlledKeepAliveHost = normalizedHost;
    managed.controlledKeepAliveContinuous = true;
    managed.keepAliveEnabled = true;
    managed.keepAliveHops = 0;
    managed.keepAliveVisited.clear();
    managed.keepAliveVisited.add(managed.view.webContents.getURL());
    managed.keepAliveNextAt = Date.now();
    this.updateState(managed, {
      keepAliveEnabled: true,
      keepAliveHops: 0
    });
    queueMicrotask(() => this.tickKeepAlive());
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

  configureKeepAlive(intervalMs: number, maxHops: number, followLinks: boolean): void {
    this.keepAliveIntervalMs = Math.max(5_000, Math.min(3_600_000, Math.floor(intervalMs || 60_000)));
    this.keepAliveMaxHops = Math.max(1, Math.min(1000, Math.floor(maxHops || 1)));
    // Lite measurement builds keep link-following disabled by default.
    // Manual Keep Alive still performs the two full scroll cycles.
    this.keepAliveFollowLinks = followLinks;
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
    if (!enabled) {
      managed.controlledKeepAliveHost = null;
      managed.controlledKeepAliveContinuous = false;
    }
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
    const controlled = managed.controlledKeepAliveContinuous && Boolean(managed.controlledKeepAliveHost);
    const canHop = controlled || (this.keepAliveFollowLinks && pagesVisited < this.keepAliveMaxHops);

    try {
      const result = (await wc.executeJavaScript(
        buildKeepAliveActionScript(
          canHop,
          Array.from(managed.keepAliveVisited),
          managed.controlledKeepAliveHost ?? undefined
        ),
        true
      )) as {
        clickedUrl?: string;
      };

      const completedAt = new Date().toISOString();

      // Controlled test mode repeats until the next proxy rotation cancels it.
      if (!controlled && pagesVisited >= this.keepAliveMaxHops) {
        managed.keepAliveEnabled = false;
        this.updateState(managed, {
          lastKeepAliveAt: completedAt,
          keepAliveEnabled: false,
          keepAliveHops: managed.keepAliveHops
        });
        return;
      }

      if (!canHop || !result.clickedUrl) {
        if (controlled) {
          // Stay alive on the current controlled page and try again shortly.
          managed.keepAliveNextAt = Date.now() + 2_000;
          this.updateState(managed, {
            lastKeepAliveAt: completedAt,
            keepAliveEnabled: true,
            keepAliveHops: managed.keepAliveHops
          });
          return;
        }

        managed.keepAliveEnabled = false;
        this.updateState(managed, {
          lastKeepAliveAt: completedAt,
          keepAliveEnabled: false,
          keepAliveHops: managed.keepAliveHops
        });
        return;
      }

      managed.keepAliveVisited.add(result.clickedUrl);
      managed.keepAliveHops += 1;
      if (controlled) managed.keepAliveNextAt = Date.now() + 1_500;
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

export function buildKeepAliveActionScript(
  allowHop: boolean,
  visitedUrls: string[] = [],
  allowedHost?: string
): string {
  return `(async () => {
    const visited = new Set(${JSON.stringify(visitedUrls)});
    const allowedHost = ${JSON.stringify(allowedHost?.toLowerCase() ?? '')};
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

    const cycles = 2;
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

    if (!${allowHop ? 'true' : 'false'}) return {};

    const blocked = /(login|log-in|logout|sign-in|signin|signup|register|account|cart|basket|checkout|payment|subscribe|privacy|terms|contact|download|delete|remove|admin|wp-admin|wp-login|author|tag|category)/i;
    const currentUrl = new URL(location.href);
    const currentHost = currentUrl.hostname.toLowerCase().replace(/^www\\./, '');
    const seen = {};
    const candidates = [];

    Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
      try {
        if (anchor.hasAttribute('download')) return;
        const rel = (anchor.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('sponsored') || rel.includes('nofollow sponsored')) return;

        const text = (anchor.textContent || '').trim();
        if (text.length < 6 || blocked.test(text)) return;

        const url = new URL(anchor.href, location.href);
        if (!/^https?:$/.test(url.protocol)) return;

        const host = url.hostname.toLowerCase().replace(/^www\\./, '');
        if (host !== currentHost) return;
        if (allowedHost && host !== allowedHost) return;

        url.hash = '';
        const normalized = url.href;
        if (normalized === currentUrl.href || visited.has(normalized)) return;
        if (blocked.test(url.pathname + url.search)) return;
        if (seen[normalized]) return;
        seen[normalized] = true;

        // Favor article-looking links, but keep a same-site content fallback.
        var score = 0;
        const lowerPath = url.pathname.toLowerCase();
        if (
          lowerPath.includes('/article/') ||
          lowerPath.includes('/blog/') ||
          lowerPath.includes('/post/') ||
          lowerPath.includes('/news/') ||
          lowerPath.includes('/story/')
        ) score += 100;
        if (anchor.closest && anchor.closest('article')) score += 80;
        if (anchor.querySelector && anchor.querySelector('h1,h2,h3,h4')) score += 60;
        if (text.length >= 20) score += 30;
        if (url.pathname.split('/').filter(Boolean).length >= 2) score += 20;

        const rect = anchor.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) score += 10;

        candidates.push({ anchor, url: normalized, score });
      } catch (_) {
        // Ignore malformed/non-web anchors.
      }
    });

    if (!candidates.length) return {};

    candidates.sort((a, b) => b.score - a.score);
    const topScore = candidates[0].score;
    const top = candidates.filter((candidate) => candidate.score >= topScore - 15);
    const chosen = top[Math.floor(Math.random() * top.length)];

    try {
      chosen.anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      await wait(250);
      chosen.anchor.target = '_self';
      chosen.anchor.focus({ preventScroll: true });
      chosen.anchor.click();
      return { clickedUrl: chosen.url };
    } catch (_) {
      return {};
    }
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
  observedResults: number;
  signature: string;
  match?: {
    url: string;
    title: string;
    organicIndex: number;
    clickPoint?: { x: number; y: number };
  };
}

export function buildGoogleResultScanScript(targetHost: string, query = ''): string {
  return `(function() {
    try {
      var target = ${JSON.stringify(targetHost.toLowerCase())};
      var queryText = ${JSON.stringify(query.toLowerCase())};
      var loc = window.location.href;
      if (/\\/sorry\\/|consent\\.google\\./.test(loc)) {
        return { blocked: true, ready: true, resultsScanned: 0, observedResults: 0, signature: '' };
      }

      var bodyText = (document.body && document.body.innerText) || '';
      if (/unusual traffic|not a robot|recaptcha/i.test(bodyText.slice(0, 2500))) {
        return { blocked: true, ready: true, resultsScanned: 0, observedResults: 0, signature: '' };
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
          if (host === target || host.endsWith('.' + target)) return true;
          if (target.indexOf('.') === -1 && host.split('.').indexOf(target) !== -1) return true;
          return false;
        } catch (_) {
          return false;
        }
      }

      var displayMentionsTarget = ${resultTextMentionsHost.toString()};

      function normalizeWords(text) {
        return String(text || '')
          .toLowerCase()
          .replace(/www\\./g, '')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .replace(/\\s+/g, ' ');
      }

      var queryTokens = normalizeWords(queryText)
        .split(' ')
        .filter(function(token) { return token.length >= 2; });

      function keywordMatches(text) {
        if (!queryTokens.length) return true;
        var normalized = ' ' + normalizeWords(text) + ' ';
        return queryTokens.every(function(token) {
          return normalized.indexOf(' ' + token + ' ') !== -1;
        });
      }

      function websiteAndKeywordMatch(text) {
        return displayMentionsTarget(text, target) && keywordMatches(text);
      }

      var searchRoot = document.querySelector('#search') || document.querySelector('#rso') || document.querySelector('main') || document.body;

      function elementRect(node) {
        if (!node || !node.getBoundingClientRect) return null;
        var rect = node.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2) return null;
        return rect;
      }

      function isGoogleDestination(url) {
        try {
          return /(^|\\.)google\\.[a-z.]+$/i.test(new URL(url, location.href).hostname);
        } catch (_) {
          return true;
        }
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
          if (!elementRect(a)) continue;
          var destination = unwrap(a.getAttribute('href') || a.href || '');
          var text = (a.innerText || a.getAttribute('aria-label') || '').trim();
          var hasHeading = Boolean(a.querySelector && a.querySelector('h3'));
          var direct = destinationMatches(destination);
          var score = 0;
          if (hasHeading) score += 100;
          if (keywordMatches(text)) score += 120;
          if (direct) score += 60;
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

      // Build a snapshot of actual organic-result anchors. This is used by
      // the main process to decide when a page has genuinely stabilized.
      // Do not use "any anchor exists" as readiness: Google's header/footer
      // links render far earlier than the organic result set.
      var organicSeen = {};
      var organicSnapshot = [];
      var organicUrls = [];
      for (var s = 0; s < anchors.length; s += 1) {
        var candidate = anchors[s];
        var candidateHref = unwrap(candidate.getAttribute('href') || candidate.href || '');
        if (!candidateHref || isGoogleDestination(candidateHref)) continue;

        var candidateContainer = candidate.closest && candidate.closest('.MjjYud, .g, [data-snhf], [data-hveid]');
        var candidateText = (((candidateContainer && candidateContainer.innerText) || candidate.innerText || '') + '').trim();
        if (/\\bSponsored\\b/i.test(candidateText.slice(0, 240))) continue;

        var hasHeading = Boolean(candidate.querySelector && candidate.querySelector('h3'));
        var looksLikeResult = hasHeading || Boolean(candidateContainer) || candidateText.length >= 18;
        if (!looksLikeResult) continue;

        var snapshotKey = candidateHref.split('#')[0] + '|' + candidateText.slice(0, 120);
        if (organicSeen[snapshotKey]) continue;
        organicSeen[snapshotKey] = true;
        organicSnapshot.push(snapshotKey);
        organicUrls.push(candidateHref.split('#')[0]);
      }

      var observedResults = organicSnapshot.length;
      var signature = organicSnapshot.slice(0, 30).join('||');
      var resultsScanned = observedResults;

      // TEXT-FIRST MATCHING:
      // Google's visible domain line and blue title are not guaranteed to
      // share the same <a> or stable class names. Start from nodes whose
      // visible text contains the target website, climb to the smallest
      // ancestor that also contains the search-keyword tokens, then choose
      // the best article/title link inside that block.
      var textCandidates = Array.prototype.slice.call(
        searchRoot ? searchRoot.querySelectorAll('cite, span, div') : []
      );
      var bestTextMatch = null;

      for (var t = 0; t < textCandidates.length; t += 1) {
        var textNode = textCandidates[t];
        var directText = (textNode.innerText || '').trim();
        if (!displayMentionsTarget(directText, target)) continue;

        var current = textNode;
        for (var depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          if (!current.querySelectorAll) continue;
          var blockText = ((current.innerText || '') + '').trim();
          if (blockText.length < 12 || blockText.length > 3500) continue;
          if (/\\bSponsored\\b/i.test(blockText.slice(0, 260))) break;
          if (!websiteAndKeywordMatch(blockText)) continue;

          var articleAnchor = bestAnchor(current, textNode.closest && textNode.closest('a[href]'));
          if (!articleAnchor) continue;

          var articleDestination = unwrap(articleAnchor.getAttribute('href') || articleAnchor.href || '');
          if (!articleDestination || isGoogleDestination(articleDestination)) continue;

          var articleTitleNode = articleAnchor.querySelector && articleAnchor.querySelector('h3');
          var articleTitle = (
            (articleTitleNode && articleTitleNode.innerText) ||
            articleAnchor.getAttribute('aria-label') ||
            articleAnchor.innerText ||
            ''
          ).trim();

          // The keyword may live in the blue title or in the same result
          // block/snippet. Requiring the full block to contain the tokens is
          // what makes this resilient to Google's split title/domain markup.
          if (!keywordMatches(blockText)) continue;

          var articleRect = elementRect(articleAnchor);
          if (!articleRect) continue;

          var articleIndex = organicUrls.indexOf(articleDestination.split('#')[0]);
          if (articleIndex < 0) articleIndex = 0;

          var score = 0;
          if (keywordMatches(articleTitle)) score += 200;
          if (destinationMatches(articleDestination)) score += 120;
          if (articleTitleNode) score += 80;
          score -= Math.min(blockText.length, 3000) / 3000;

          if (!bestTextMatch || score > bestTextMatch.score) {
            bestTextMatch = {
              score: score,
              anchor: articleAnchor,
              url: articleDestination,
              title: articleTitle,
              organicIndex: articleIndex
            };
          }
          break;
        }
      }

      if (bestTextMatch) {
        bestTextMatch.anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        var bestRect = elementRect(bestTextMatch.anchor);
        if (bestRect) {
          return {
            blocked: false,
            ready: true,
            resultsScanned: resultsScanned,
            observedResults: observedResults,
            signature: signature,
            match: {
              url: bestTextMatch.url,
              title: bestTextMatch.title,
              organicIndex: bestTextMatch.organicIndex,
              clickPoint: {
                x: bestRect.left + Math.min(bestRect.width / 2, Math.max(12, bestRect.width - 12)),
                y: bestRect.top + bestRect.height / 2
              }
            }
          };
        }
      }

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
        var rect = elementRect(anchor);
        if (!rect) continue;

        var organicIndex = organicUrls.indexOf(anchorDestination.split('#')[0]);
        if (organicIndex < 0) organicIndex = 0;
        return {
          blocked: false,
          ready: true,
          resultsScanned: resultsScanned,
          observedResults: observedResults,
          signature: signature,
          match: {
            url: anchorDestination,
            title: titleText,
            organicIndex: organicIndex,
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
        var fallbackRect = elementRect(fallbackAnchor);
        if (!fallbackRect) continue;
        var fallbackDestination = unwrap(fallbackAnchor.getAttribute('href') || fallbackAnchor.href || '');
        var fallbackTitleNode = fallbackAnchor.querySelector && fallbackAnchor.querySelector('h3');
        var fallbackTitle = ((fallbackTitleNode && fallbackTitleNode.innerText) || fallbackAnchor.getAttribute('aria-label') || fallbackAnchor.innerText || '').trim();
        fallbackAnchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        fallbackRect = elementRect(fallbackAnchor) || fallbackRect;
        var fallbackIndex = organicUrls.indexOf(fallbackDestination.split('#')[0]);
        if (fallbackIndex < 0) fallbackIndex = 0;
        return {
          blocked: false,
          ready: true,
          resultsScanned: resultsScanned,
          observedResults: observedResults,
          signature: signature,
          match: {
            url: fallbackDestination,
            title: fallbackTitle,
            organicIndex: fallbackIndex,
            clickPoint: {
              x: fallbackRect.left + Math.min(fallbackRect.width / 2, Math.max(12, fallbackRect.width - 12)),
              y: fallbackRect.top + fallbackRect.height / 2
            }
          }
        };
      }

      return {
        blocked: false,
        ready: observedResults > 0 || document.readyState === 'complete',
        resultsScanned: resultsScanned,
        observedResults: observedResults,
        signature: signature
      };
    } catch (_) {
      return { blocked: false, ready: false, resultsScanned: 0, observedResults: 0, signature: '' };
    }
  })()`;
}

export function buildClickGoogleTargetResultScript(targetHost: string, query = ''): string {
  return `(function() {
    try {
      var target = ${JSON.stringify(targetHost.toLowerCase())};
      var queryText = ${JSON.stringify(query.toLowerCase())};
      var displayMentionsTarget = ${resultTextMentionsHost.toString()};

      function normalizeWords(text) {
        return String(text || '')
          .toLowerCase()
          .replace(/www\\./g, '')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .replace(/\\s+/g, ' ');
      }

      var queryTokens = normalizeWords(queryText)
        .split(' ')
        .filter(function(token) { return token.length >= 2; });

      function keywordMatches(text) {
        if (!queryTokens.length) return true;
        var normalized = ' ' + normalizeWords(text) + ' ';
        return queryTokens.every(function(token) {
          return normalized.indexOf(' ' + token + ' ') !== -1;
        });
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
          if (host === target || host.endsWith('.' + target)) return true;
          if (target.indexOf('.') === -1 && host.split('.').indexOf(target) !== -1) return true;
          return false;
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
        var textMatch = displayMentionsTarget(displayText, target) && keywordMatches(nearbyText);
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
  // Accept non-network schemes used internally, especially about:blank.
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?/.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
