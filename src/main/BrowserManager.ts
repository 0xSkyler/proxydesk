import { EventEmitter } from 'node:events';
import { app, BrowserView, BrowserWindow, clipboard, session, type Session } from 'electron';
import type { BroadcastSearchResult, BrowserBounds, BrowserState } from '../shared/types/browser';
import type { ProxyRecord } from '../shared/types/proxy';
import { EPHEMERAL_PARTITION_PREFIX, PARTITION_PREFIX } from '../shared/constants';
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
      crashCount: 0
    };

    const managed: ManagedBrowser = { id, view, session: ses, state, restartAttempts: 0, googleBlockRetries: 0 };
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
  async broadcastSearch(id: number, query: string, matchText: string): Promise<BroadcastSearchResult> {
    const managed = this.get(id);
    const wc = managed.view.webContents;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en`;
    const ranAt = new Date().toISOString();

    try {
      await wc.loadURL(searchUrl);
    } catch (err) {
      return { browserId: id, status: 'error', error: `Failed to load search page: ${(err as Error).message}`, ranAt };
    }

    // loadURL's promise resolves on navigation commit, not on the results
    // actually being painted — give the page a moment to render before
    // reading its DOM.
    await delay(1500);

    let extracted: ExtractedSearchPage;
    try {
      extracted = (await wc.executeJavaScript(EXTRACT_GOOGLE_RESULTS_SCRIPT)) as ExtractedSearchPage;
    } catch (err) {
      return { browserId: id, status: 'error', error: `Failed to read search results: ${(err as Error).message}`, ranAt };
    }

    if (extracted.blocked) {
      return { browserId: id, status: 'blocked', landedUrl: wc.getURL(), ranAt };
    }

    const results = extracted.results ?? [];
    const needle = matchText.trim().toLowerCase();
    const match = needle
      ? results.find((r) => r.title.toLowerCase().includes(needle) || r.text.toLowerCase().includes(needle))
      : results[0];

    if (!match) {
      return { browserId: id, status: 'no-match', landedUrl: wc.getURL(), resultsScanned: results.length, ranAt };
    }

    try {
      await wc.loadURL(match.url);
    } catch (err) {
      return {
        browserId: id,
        status: 'error',
        error: `Matched "${match.title}" but failed to open it: ${(err as Error).message}`,
        ranAt
      };
    }

    return {
      browserId: id,
      status: 'matched',
      landedUrl: match.url,
      matchedTitle: match.title,
      resultsScanned: results.length,
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

  /**
   * Periodically nudges every managed browser with a full page scroll (down
   * to the bottom, back to the top, twice over) so sites see real, sustained
   * scroll/DOM activity and don't treat the tab as idle — this is what keeps
   * a logged-in session (search results, a shopping cart, a form in
   * progress) from timing out while you're away from the app and not
   * actually interacting with anything. A 1px nudge was too small for some
   * sites' idle detectors to register as real activity, so this walks the
   * whole scrollable height instead. Safe to call repeatedly with new
   * settings — it always clears any previous timer first, so re-configuring
   * (interval change, or turning it off) never stacks multiple timers.
   */
  setKeepAlive(enabled: boolean, intervalMs: number): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (!enabled) return;

    this.keepAliveTimer = setInterval(() => {
      for (const managed of this.browsers.values()) {
        const wc = managed.view.webContents;
        if (wc.isDestroyed()) continue;
        wc.executeJavaScript(KEEP_ALIVE_SCROLL_SCRIPT, true).catch(() => {
          // Page not ready, no scrollable content, or a cross-origin/CSP
          // quirk — never worth surfacing as an error for a background nudge.
        });
      }
    }, intervalMs);
  }
}

/**
 * Scrolls the page all the way to the bottom and back to the top, twice
 * (down, up, down, up), pausing at each end so the motion — and the scroll
 * events it fires — look like a real, sustained visit rather than a single
 * flicked wheel-tick. The browser's native `behavior: 'smooth'` scroll is
 * too quick to read as a slow, deliberate scroll (it runs at a roughly
 * fixed pixel speed with no way to configure it), so this animates the
 * scroll itself frame-by-frame over a fixed duration instead, which is what
 * actually lets the speed be tuned via SCROLL_DURATION_MS/PAUSE_MS below.
 * Runs as an async IIFE so `executeJavaScript`'s returned promise resolves
 * only once the whole sequence finishes.
 */
const KEEP_ALIVE_SCROLL_SCRIPT = `
(async () => {
  const SCROLL_DURATION_MS = 3500; // time to travel from top to bottom (or back) — raise to scroll slower
  const PAUSE_MS = 900; // pause at each end before reversing direction

  const scrollEl = document.scrollingElement || document.documentElement;
  const maxScroll = Math.max(0, scrollEl.scrollHeight - window.innerHeight);
  if (maxScroll <= 0) {
    // Nothing to scroll (short page) — still nudge with a tiny scroll so
    // there is at least some activity for the idle detector to see.
    window.scrollBy(0, 1);
    window.scrollBy(0, -1);
    return;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Animates the scroll position to \`target\` over \`duration\` ms with a
  // gentle ease-in-out, rather than jumping/native-smooth-scrolling there —
  // this is the actual knob that controls how slow the motion looks.
  const animateScrollTo = (target, duration) =>
    new Promise((resolve) => {
      const startY = window.scrollY;
      const delta = target - startY;
      if (delta === 0) {
        resolve();
        return;
      }
      const startTime = performance.now();
      function step(now) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        window.scrollTo(0, startY + delta * eased);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });

  for (let cycle = 0; cycle < 2; cycle++) {
    await animateScrollTo(maxScroll, SCROLL_DURATION_MS);
    await wait(PAUSE_MS);
    await animateScrollTo(0, SCROLL_DURATION_MS);
    await wait(PAUSE_MS);
  }
})();
`;

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
    if (/unusual traffic|not a robot|recaptcha/i.test(bodyText.slice(0, 2000))) return { blocked: true };

    var anchors = Array.prototype.slice.call(document.querySelectorAll('a'));
    var seen = {};
    var results = [];
    anchors.forEach(function (a) {
      var h3 = a.querySelector('h3');
      if (!h3) return;
      var href = a.getAttribute('href') || '';
      var redirectMatch = href.match(/^\\/url\\?q=([^&]+)/);
      if (redirectMatch) href = decodeURIComponent(redirectMatch[1]);
      if (!/^https?:\\/\\//.test(href)) return;
      if (/^https?:\\/\\/(www\\.)?google\\./.test(href)) return;
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

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?/.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
