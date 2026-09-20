import { app, BrowserWindow, session, shell } from 'electron';
import path from 'node:path';
import { BrowserManager } from './BrowserManager';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { StorageManager } from './StorageManager';
import { registerIpc } from './ipc/registerIpc';
import { logger } from './Logger';
import { BROWSER_IDS } from '../shared/types/browser';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager;
let proxyManager: ProxyManager;
let settingsManager: SettingsManager;
let storageManager: StorageManager;
let rotationTimer: NodeJS.Timeout | null = null;

// TOOLBAR_HEIGHT/SIDEBAR values mirror the renderer's CSS layout constants
// (see src/renderer/styles/layout.css) so BrowserView bounds line up
// pixel-for-pixel with the placeholder area each BrowserPanel renders.
const GLOBAL_TOOLBAR_HEIGHT = 0; // renderer reports absolute bounds directly; kept for documentation.
void GLOBAL_TOOLBAR_HEIGHT;

async function createWindow(): Promise<void> {
  // createWindow() is only ever called after bootstrap() has initialized
  // settingsManager (once directly, once more from app.on('activate', ...)
  // which only fires post-bootstrap on macOS reactivation).
  const { windowWidth, windowHeight } = settingsManager.get().application;
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0f1115',
    title: 'ProxyDesk',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  browserManager.attachWindow(mainWindow);

  // Never let the shell window (or any embedded BrowserView) navigate to
  // arbitrary external protocol handlers or spawn new native windows —
  // links that want a new window open in the OS default browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  storageManager = new StorageManager();
  await storageManager.init();

  settingsManager = new SettingsManager(storageManager);
  await settingsManager.init();

  proxyManager = new ProxyManager(storageManager, settingsManager);
  await proxyManager.init();

  browserManager = new BrowserManager();
  // Remove browser cookies/cache/site storage left by any older persistent
  // build for every possible workspace id before this run starts.
  await browserManager.purgeLegacyPersistentSessions(BROWSER_IDS);

  await createWindow();

  registerIpc({
    browserManager,
    proxyManager,
    settingsManager,
    getBrowserIds: () => BROWSER_IDS.slice(0, settingsManager.get().browser.browserCount)
  });

  const settings = settingsManager.get();
  const browserIds = BROWSER_IDS.slice(0, settings.browser.browserCount);

  for (const id of browserIds) {
    await browserManager.createBrowser(id, {
      persistSessions: settings.browser.persistSessions,
      startPage: settings.browser.startPage,
      userAgent: settings.browser.userAgent,
      onGoogleBlocked: (browserId, continueUrl) => void handleGoogleBlocked(browserId, continueUrl)
    });
    if (settings.browser.keepAliveEnabled) browserManager.setBrowserKeepAlive(id, true, true);
  }

  if (settings.proxy.autoLoadOnStartup) {
    try {
      const summary = await proxyManager.reload(browserIds, settings.proxy.preferredCountryCode);
      for (const assignment of summary.assignments) {
        await browserManager.assignProxy(assignment.browserId, assignment.proxy);
      }
      logger.info(
        'application',
        `Startup proxy assignment complete: ${summary.working}/${summary.found} working, ` +
          `${summary.assignments.filter((a) => a.proxy).length}/${browserIds.length} browsers assigned.`
      );
    } catch (err) {
      logger.warn('application', `Startup proxy load failed: ${(err as Error).message}. Continuing without proxies.`);
    }
  }

  browserManager.configureKeepAlive(
    settings.browser.keepAliveIntervalSec * 1000,
    settings.browser.keepAliveMaxHops,
    settings.browser.keepAliveFollowLinks
  );
  if (settings.browser.keepAliveEnabled) browserManager.setKeepAliveAll(true, true);
  let globalKeepAliveEnabled = settings.browser.keepAliveEnabled;
  scheduleProxyRotation();

  settingsManager.onChange((updated) => {
    browserManager.configureKeepAlive(
      updated.browser.keepAliveIntervalSec * 1000,
      updated.browser.keepAliveMaxHops,
      updated.browser.keepAliveFollowLinks
    );
    if (updated.browser.keepAliveEnabled !== globalKeepAliveEnabled) {
      globalKeepAliveEnabled = updated.browser.keepAliveEnabled;
      browserManager.setKeepAliveAll(globalKeepAliveEnabled, globalKeepAliveEnabled);
    }
    scheduleProxyRotation();
    void syncBrowserCount(updated);
  });

  logger.info('application', 'ProxyDesk ready.');
}

/**
 * Re-arms second-based proxy rotation from the existing proxy pool.
 */
function scheduleProxyRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }

  const proxySettings = settingsManager.get().proxy;
  if (!proxySettings.autoRotationEnabled) return;

  const seconds = Math.max(5, Math.min(86400, Math.floor(proxySettings.rotationIntervalSec || 60)));
  rotationTimer = setInterval(() => void runProxyRotation(), seconds * 1000);
  logger.info('application', `Automatic proxy rotation armed: every ${seconds} second(s).`);
}

async function runProxyRotation(): Promise<void> {
  const settings = settingsManager.get();
  const browserIds = BROWSER_IDS.slice(0, settings.browser.browserCount);
  try {
    const summary = await proxyManager.rotate(browserIds, settings.proxy.preferredCountryCode);
    for (const assignment of summary.assignments) {
      await browserManager.assignProxy(assignment.browserId, assignment.proxy);
    }
    logger.info(
      'proxy',
      `Automatic proxy rotation complete: ${summary.assignments.filter((a) => a.proxy).length}/${browserIds.length} browsers reassigned.`
    );
  } catch (err) {
    logger.warn('proxy', `Automatic proxy rotation failed: ${(err as Error).message}. Will retry on the next cycle.`);
  }
}

/**
 * Browsers are only ever created up front at bootstrap for whatever
 * `browserCount` was at the time — nothing previously reacted when the
 * setting changed later in Settings, so raising it past the number of
 * browsers actually running just added empty grid tiles with no real
 * BrowserView behind them (rendered as solid black, since there was never
 * any Chromium content to show). This brings the live set of managed
 * browsers in line with the current `browserCount` setting: creating
 * whatever new ids are now in range, and tearing down any that fell out of
 * range when the count was lowered.
 */
async function syncBrowserCount(settings: ReturnType<SettingsManager['get']>): Promise<void> {
  const desiredIds = new Set(BROWSER_IDS.slice(0, settings.browser.browserCount));
  const existingIds = new Set(browserManager.getAll().map((b) => b.id));

  const toCreate = Array.from(desiredIds).filter((id) => !existingIds.has(id));
  const toDestroy = Array.from(existingIds).filter((id) => !desiredIds.has(id));

  for (const id of toCreate) {
    await browserManager.createBrowser(id, {
      persistSessions: settings.browser.persistSessions,
      startPage: settings.browser.startPage,
      userAgent: settings.browser.userAgent,
      onGoogleBlocked: (browserId, continueUrl) => void handleGoogleBlocked(browserId, continueUrl)
    });
  }
  for (const id of toDestroy) {
    await browserManager.destroyBrowser(id);
  }

  if (toCreate.length > 0) {
    logger.info('application', `Browser count increased — created ${toCreate.length} new browser(s).`);
  }
  if (toDestroy.length > 0) {
    logger.info('application', `Browser count decreased — closed ${toDestroy.length} browser(s).`);
  }
}

/**
 * Fires when a browser lands on Google's CAPTCHA interstitial while
 * browsing normally (see BrowserManager.onGoogleBlocked) — the same
 * signal the deliberate "Check Google Trust" feature looks for, just
 * discovered live. Marks the proxy that just got flagged, swaps in a
 * different one, and retries the page the browser was actually trying to
 * reach (not the interstitial itself). Only reacts when "Auto-replace
 * failed proxies" is on (Settings > Proxy) — BrowserManager already caps
 * how many times this fires in a row per browser (see
 * MAX_GOOGLE_BLOCK_RETRIES), so this itself doesn't need its own limit.
 */
async function handleGoogleBlocked(browserId: number, continueUrl: string): Promise<void> {
  const settings = settingsManager.get();
  if (!settings.proxy.autoReplaceFailed) return;

  try {
    await proxyManager.markGoogleBlocked(browserId);
    const newProxy = await proxyManager.replaceFailed(browserId);
    if (!newProxy) {
      logger.warn('proxy', `Browser ${browserId}: no alternative proxy available after a Google CAPTCHA block.`);
      return;
    }
    // assignProxy() reloads whatever page the browser is currently on —
    // that's the CAPTCHA interstitial itself right now — so follow it with
    // an explicit navigate() back to the page that was actually wanted.
    await browserManager.assignProxy(browserId, newProxy);
    await browserManager.navigate(browserId, continueUrl);
    logger.info(
      'proxy',
      `Browser ${browserId}: swapped to ${newProxy.host}:${newProxy.port} after a Google CAPTCHA block and retried.`
    );
  } catch (err) {
    logger.warn('proxy', `Browser ${browserId}: failed to auto-recover from a Google CAPTCHA block: ${(err as Error).message}`);
  }
}

app.whenReady().then(() => {
  // Electron security default: block permission requests (camera, mic,
  // geolocation, notifications) from any embedded proxied content unless a
  // future feature explicitly needs one.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  void bootstrap().catch((err) => {
    logger.error('application', `Fatal startup error: ${(err as Error).stack ?? err}`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (rotationTimer) clearInterval(rotationTimer);
  void browserManager?.destroyAll();
});

process.on('uncaughtException', (err) => {
  logger.error('application', `Uncaught exception: ${err.stack ?? err.message}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error('application', `Unhandled rejection: ${String(reason)}`);
});
