import { EventEmitter } from 'node:events';
import { app, BrowserView, BrowserWindow, clipboard, session, type Session } from 'electron';
import type { BroadcastSearchResult, BrowserBounds, BrowserState } from '../shared/types/browser';
import type { ProxyRecord } from '../shared/types/proxy';
import { EPHEMERAL_PARTITION_PREFIX, PARTITION_PREFIX } from '../shared/constants';
import { buildGoogleSearchUrl, hostMatchesTarget, normalizeTargetHost } from '../shared/seo';
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

  private partitionFor(id: number, persist: boolean): string {
    return persist ? `${PARTITION_PREFIX}${id}` : `${EPHEMERAL_PARTITION_PREFIX}${id}-${process.pid}`;
  }

  async createBrowser(id: number, options: BrowserManagerOptions): Promise<void> {
    if (this.browsers.has(id)) return;

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
      keepAliveBusy: false
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

      try {
        await wc.loadURL(searchUrl);
      } catch (err) {
        return {
          browserId: id,
          status: 'error',
          error: `Failed to load Google results page ${pageIndex + 1}: ${(err as Error).message}`,
          ranAt
        };
      }

      await delay(1400);

      let extracted: ExtractedSearchPage;
      try {
        extracted = (await wc.executeJavaScript(EXTRACT_GOOGLE_RESULTS_SCRIPT)) as ExtractedSearchPage;
      } catch (err) {
        return {
          browserId: id,
          status: 'error',
          error: `Failed to read Google results: ${(err as Error).message}`,
          ranAt
        };
      }

      if (extracted.blocked) {
        return {
          browserId: id,
          status: 'blocked',
          landedUrl: wc.getURL(),
          resultsScanned: totalScanned,
          ranAt
        };
      }

      const results = extracted.results ?? [];
      totalScanned += results.length;
      const matchIndex = results.findIndex((result) => hostMatchesTarget(result.url, targetHost));
      if (matchIndex < 0) continue;

      const match = results[matchIndex];
      const clicked = (await wc
        .executeJavaScript(buildClickGoogleResultScript(match.url), true)
        .catch(() => false)) as boolean;

      if (!clicked) {
        return {
          browserId: id,
          status: 'error',
          error: `Found "${match.title}" but could not click its Google result link.`,
          landedUrl: wc.getURL(),
          resultsScanned: totalScanned,
          ranAt
        };
      }

      const deadline = Date.now() + 12_000;
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
          error: `Google result was clicked, but the browser did not land on ${targetHost} within 12 seconds.`,
          landedUrl,
          matchedTitle: match.title,
          resultsScanned: totalScanned,
          position: pageIndex * 10 + matchIndex + 1,
          resultPage: pageIndex + 1,
          ranAt
        };
      }

      this.setBrowserKeepAlive(id, true, true);
      return {
        browserId: id,
        status: 'matched',
        landedUrl,
        matchedTitle: match.title,
        resultsScanned: totalScanned,
        position: pageIndex * 10 + matchIndex + 1,
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
    this.window?.removeBrowserView(managed.view);
    // @ts-expect-error — destroy() exists on the underlying WebContents at runtime
    // across supported Electron versions but is intentionally left out of some
    // type defs; guarded by the isDestroyed check to avoid double-free errors.
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.destroy?.();
    this.browsers.delete(id);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(Array.from(this.browsers.keys()).map((id) => this.destroyBrowser(id)));
  }

  copyToClipboard(text: string): void {
    clipboard.writeText(text);
  }

  configureKeepAlive(intervalMs: number, maxHops: number, followLinks: boolean): void {
    this.keepAliveIntervalMs = Math.max(5_000, Math.min(3_600_000, Math.floor(intervalMs || 60_000)));
    this.keepAliveMaxHops = Math.max(0, Math.min(1000, Math.floor(maxHops || 0)));
    this.keepAliveFollowLinks = followLinks;

    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => this.tickKeepAlive(), 1000);
    }
  }

  setKeepAlive(enabled: boolean, intervalMs: number): void {
    this.configureKeepAlive(intervalMs, this.keepAliveMaxHops, this.keepAliveFollowLinks);
    this.setKeepAliveAll(enabled, enabled);
  }

  setBrowserKeepAlive(id: number, enabled: boolean, resetHops = false): void {
    const managed = this.get(id);
    managed.keepAliveEnabled = enabled;
    if (resetHops) managed.keepAliveHops = 0;
    managed.keepAliveNextAt = Date.now() + Math.min(1000, this.keepAliveIntervalMs);
    this.updateState(managed, {
      keepAliveEnabled: enabled,
      keepAliveHops: managed.keepAliveHops
    });
  }

  setKeepAliveAll(enabled: boolean, resetHops = false): void {
    for (const managed of this.browsers.values()) {
      managed.keepAliveEnabled = enabled;
      if (resetHops) managed.keepAliveHops = 0;
      managed.keepAliveNextAt = Date.now() + Math.min(1000, this.keepAliveIntervalMs);
      this.updateState(managed, {
        keepAliveEnabled: enabled,
        keepAliveHops: managed.keepAliveHops
      });
    }
  }

  private tickKeepAlive(): void {
    const now = Date.now();
    for (const managed of this.browsers.values()) {
      if (!managed.keepAliveEnabled || managed.keepAliveBusy || now < managed.keepAliveNextAt) continue;

      const wc = managed.view.webContents;
      if (wc.isDestroyed() || managed.state.loading) {
        managed.keepAliveNextAt = now + 2000;
        continue;
      }

      managed.keepAliveBusy = true;
      const jitter = 0.8 + Math.random() * 0.4;
      managed.keepAliveNextAt = now + Math.round(this.keepAliveIntervalMs * jitter);
      void this.runKeepAliveAction(managed).finally(() => {
        managed.keepAliveBusy = false;
      });
    }
  }

  private async runKeepAliveAction(managed: ManagedBrowser): Promise<void> {
    const wc = managed.view.webContents;
    const canHop =
      this.keepAliveFollowLinks && this.keepAliveMaxHops > 0 && managed.keepAliveHops < this.keepAliveMaxHops;

    try {
      const result = (await wc.executeJavaScript(buildKeepAliveActionScript(canHop), true)) as {
        nextUrl?: string;
      };

      this.updateState(managed, {
        lastKeepAliveAt: new Date().toISOString(),
        keepAliveEnabled: true,
        keepAliveHops: managed.keepAliveHops
      });

      if (canHop && result?.nextUrl) {
        await wc.loadURL(result.nextUrl);
        managed.keepAliveHops += 1;
        this.updateState(managed, {
          keepAliveHops: managed.keepAliveHops,
          lastKeepAliveAt: new Date().toISOString()
        });
      }
    } catch {
      // A navigation can make script execution temporarily unavailable.
      // Keep Alive is best-effort and will retry on its next scheduled tick.
    }
  }
}

function buildKeepAliveActionScript(allowHop: boolean): string {
  return `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.scrollingElement || document.documentElement;
    const maxScroll = Math.max(0, root.scrollHeight - window.innerHeight);

    if (maxScroll > 0) {
      const current = window.scrollY;
      const direction = Math.random() < 0.72 ? 1 : -1;
      const distance = Math.max(180, Math.round(window.innerHeight * (0.35 + Math.random() * 0.9)));
      const target = Math.max(0, Math.min(maxScroll, current + direction * distance));
      window.scrollTo({ top: target, behavior: 'smooth' });
      await wait(650 + Math.round(Math.random() * 900));
    } else {
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
      await wait(120);
    }

    if (!${allowHop ? 'true' : 'false'} || Math.random() > 0.35) return {};

    const blocked = /(login|log-in|logout|sign-in|signin|signup|register|account|cart|basket|checkout|payment|subscribe|privacy|terms|contact|download|delete|remove|admin|wp-admin|wp-login)/i;
    const currentUrl = new URL(location.href);
    const links = Array.from(document.querySelectorAll('a[href]')).filter((anchor) => {
      try {
        if (anchor.hasAttribute('download')) return false;
        if ((anchor.getAttribute('rel') || '').toLowerCase().includes('sponsored')) return false;
        const text = (anchor.textContent || '').trim();
        if (text.length < 5 || blocked.test(text)) return false;
        const url = new URL(anchor.href, location.href);
        if (!/^https?:$/.test(url.protocol)) return false;
        if (url.hostname !== currentUrl.hostname) return false;
        if (url.href === currentUrl.href || blocked.test(url.pathname + url.search)) return false;
        const rect = anchor.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    });

    if (links.length === 0) return {};
    const selected = links[Math.floor(Math.random() * links.length)];
    return { nextUrl: selected.href };
  })()`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExtractedSearchPage {
  blocked: boolean;
  results?: Array<{ url: string; title: string; text: string }>;
  scriptError?: string;
}

/**
 * Runs inside the page (via executeJavaScript), not in this process — no
 * access to Node or anything outside the DOM. Deliberately format-tolerant
 * rather than tied to today's exact Google markup: any `<a>` that wraps an
 * `<h3>` is treated as an organic result link (this has been the stable
 * shape of Google's organic result anchors for years, independent of the
 * surrounding layout classes that change often), and Google's own `/url?q=`
 * redirect wrapper is unwrapped when present. Ads, "People also ask", and
 * any other google.* links are skipped. An "unusual traffic" / consent
 * interstitial is detected up front so a blocked run is never mistaken for
 * a genuine zero-results page.
 */
const EXTRACT_GOOGLE_RESULTS_SCRIPT = `(function() {
  try {
    var loc = window.location.href;
    if (/\\/sorry\\/|consent\\.google\\./.test(loc)) return { blocked: true };
    var bodyText = (document.body && document.body.innerText) || '';
    if (/unusual traffic|not a robot|recaptcha/i.test(bodyText.slice(0, 2500))) return { blocked: true };

    function unwrap(href) {
      try {
        var resolved = new URL(href, location.origin);
        if (resolved.hostname.indexOf('google.') !== -1 && resolved.pathname === '/url') {
          return resolved.searchParams.get('q') || resolved.searchParams.get('url') || href;
        }
        return resolved.href;
      } catch (_) {
        return href;
      }
    }

    var anchors = Array.prototype.slice.call(document.querySelectorAll('a'));
    var seen = {};
    var results = [];
    anchors.forEach(function (a) {
      var h3 = a.querySelector('h3');
      if (!h3) return;
      var href = unwrap(a.getAttribute('href') || '');
      if (!/^https?:\\/\\//.test(href)) return;
      try {
        if (/(^|\\.)google\\.[a-z.]+$/i.test(new URL(href).hostname)) return;
      } catch (_) {
        return;
      }
      if (seen[href]) return;
      seen[href] = true;
      var container = a.closest('div') || a;
      var text = container.innerText || a.innerText || '';
      results.push({ url: href, title: h3.innerText || '', text: text.slice(0, 500) });
    });
    return { blocked: false, results: results.slice(0, 20) };
  } catch (e) {
    return { blocked: false, results: [], scriptError: String(e) };
  }
})()`;

function buildClickGoogleResultScript(targetUrl: string): string {
  return `(function() {
    var target = ${JSON.stringify(targetUrl)};
    function unwrap(href) {
      try {
        var resolved = new URL(href, location.origin);
        if (resolved.hostname.indexOf('google.') !== -1 && resolved.pathname === '/url') {
          return resolved.searchParams.get('q') || resolved.searchParams.get('url') || href;
        }
        return resolved.href;
      } catch (_) {
        return href;
      }
    }

    var anchors = Array.prototype.slice.call(document.querySelectorAll('a'));
    for (var i = 0; i < anchors.length; i += 1) {
      var anchor = anchors[i];
      if (!anchor.querySelector('h3')) continue;
      if (unwrap(anchor.getAttribute('href') || '') !== target) continue;
      anchor.click();
      return true;
    }
    return false;
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
