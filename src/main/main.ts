import { app, BrowserWindow, session, shell } from 'electron';
import path from 'node:path';
import { BrowserManager } from './BrowserManager';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { StorageManager } from './StorageManager';
import { registerIpc } from './ipc/registerIpc';
import { logger } from './Logger';
import { BROWSER_IDS } from '../shared/types/browser';
import type { ProxyRotationInterval } from '../shared/types/settings';

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
      userAgent: settings.browser.userAgent
    });
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

  browserManager.setKeepAlive(settings.browser.keepAliveEnabled, settings.browser.keepAliveIntervalSec * 1000);
  scheduleProxyRotation();

  // Both the keep-alive nudge timer and the proxy-rotation timer only read
  // settings at the moment they're (re)armed, so a live change in Settings
  // needs to re-arm them — otherwise flipping "Keep sessions alive" on, or
  // switching the rotation interval, would silently do nothing until a
  // restart.
  settingsManager.onChange((updated) => {
    browserManager.setKeepAlive(updated.browser.keepAliveEnabled, updated.browser.keepAliveIntervalSec * 1000);
    scheduleProxyRotation();
    void syncBrowserCount(updated);
  });

  logger.info('application', 'ProxyDesk ready.');
}

/** Milliseconds for each rotation choice, or null for 'off'/'manual' (no
 * automatic timer — the user triggers reassignment by hand via the toolbar). */
function rotationIntervalMs(interval: ProxyRotationInterval): number | null {
  switch (interval) {
    case '10m':
      return 10 * 60 * 1000;
    case '30m':
      return 30 * 60 * 1000;
    case '60m':
      return 60 * 60 * 1000;
    case 'off':
    case 'manual':
    default:
      return null;
  }
}

/**
 * (Re-)arms the automatic proxy-rotation timer from the current setting.
 * Always clears any previous timer first, so calling this again after a
 * settings change (or at startup) never stacks multiple timers running the
 * same rotation concurrently.
 */
function scheduleProxyRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }

  const ms = rotationIntervalMs(settingsManager.get().proxy.rotationInterval);
  if (ms == null) return;

  rotationTimer = setInterval(() => void runProxyRotation(), ms);
  logger.info('application', `Automatic proxy rotation armed: every ${ms / 60000} minute(s).`);
}

/**
 * One rotation cycle: validate the known proxy pool, assign fresh ones to
 * every browser, and apply each assignment to that browser's real session
 * (which also reloads it — see BrowserManager.assignProxy) so switching off
 * a poorly-performing public proxy actually takes effect, not just in the
 * UI's bookkeeping.
 */
async function runProxyRotation(): Promise<void> {
  const settings = settingsManager.get();
  const browserIds = BROWSER_IDS.slice(0, settings.browser.browserCount);
  try {
    const summary = await proxyManager.reload(browserIds, settings.proxy.preferredCountryCode);
    for (const assignment of summary.assignments) {
      await browserManager.assignProxy(assignment.browserId, assignment.proxy);
    }
    logger.info(
      'proxy',
      `Automatic proxy rotation complete: ${summary.working}/${summary.found} working, ` +
        `${summary.assignments.filter((a) => a.proxy).length}/${browserIds.length} browsers reassigned.`
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
      userAgent: settings.browser.userAgent
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
