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

// TOOLBAR_HEIGHT/SIDEBAR values mirror the renderer's CSS layout constants
// (see src/renderer/styles/layout.css) so BrowserView bounds line up
// pixel-for-pixel with the placeholder area each BrowserPanel renders.
const GLOBAL_TOOLBAR_HEIGHT = 0; // renderer reports absolute bounds directly; kept for documentation.
void GLOBAL_TOOLBAR_HEIGHT;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
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

  logger.info('application', 'ProxyDesk ready.');
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
  void browserManager?.destroyAll();
});

process.on('uncaughtException', (err) => {
  logger.error('application', `Uncaught exception: ${err.stack ?? err.message}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error('application', `Unhandled rejection: ${String(reason)}`);
});
