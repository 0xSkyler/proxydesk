import { EventEmitter } from 'node:events';
import { app, BrowserView, BrowserWindow, clipboard, session, type Session } from 'electron';
import type { BrowserBounds, BrowserState } from '../shared/types/browser';
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
}

interface ManagedBrowser {
  id: number;
  view: BrowserView;
  session: Session;
  state: BrowserState;
  restartAttempts: number;
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
      url: options.startPage,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      proxy: null,
      connectionStatus: 'idle',
      crashCount: 0
    };

    const managed: ManagedBrowser = { id, view, session: ses, state, restartAttempts: 0 };
    this.browsers.set(id, managed);
    this.wireEvents(managed, options);

    this.window?.addBrowserView(view);
    await view.webContents.loadURL(options.startPage).catch((err) => {
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
    wc.on('did-navigate', (_e, url) => this.updateState(managed, { url }));
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
      await managed.view.webContents.loadURL(lastUrl || options.startPage);
      this.updateState(managed, { connectionStatus: 'connected' });
    } catch (err) {
      logger.warn('browser', `Browser ${managed.id} restart attempt failed: ${(err as Error).message}`);
    }
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
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?/.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
