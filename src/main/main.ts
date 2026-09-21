import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { BrowserManager } from './BrowserManager';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { StorageManager } from './StorageManager';
import { SeoAutomationManager } from './SeoAutomationManager';
import { registerIpc } from './ipc/registerIpc';
import { logger } from './Logger';
import { BROWSER_IDS } from '../shared/types/browser';
import { normalizeBrowserCount } from '../shared/types/automation';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager;
let proxyManager: ProxyManager;
let settingsManager: SettingsManager;
let storageManager: StorageManager;
let automationManager: SeoAutomationManager;
let activeBrowserCount = 10;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: '#0f1115',
    title: 'ProxyDesk SEO Tracker Lite',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  browserManager.attachWindow(mainWindow);

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function ensureBrowserCount(count: number): Promise<number[]> {
  const normalized = normalizeBrowserCount(count);
  const desired = new Set(BROWSER_IDS.slice(0, normalized));
  const existing = new Set(browserManager.getAll().map((browser) => browser.id));

  for (const id of Array.from(existing)) {
    if (!desired.has(id)) await browserManager.destroyBrowser(id);
  }

  for (const id of Array.from(desired)) {
    if (existing.has(id)) continue;
    await browserManager.createBrowser(id, {
      persistSessions: false,
      startPage: 'https://www.google.com/',
      userAgent: ''
    });
  }

  activeBrowserCount = normalized;
  return BROWSER_IDS.slice(0, activeBrowserCount);
}

async function bootstrap(): Promise<void> {
  storageManager = new StorageManager();
  await storageManager.init();

  settingsManager = new SettingsManager(storageManager);
  await settingsManager.init();

  proxyManager = new ProxyManager(storageManager, settingsManager);
  await proxyManager.init();

  browserManager = new BrowserManager();
  activeBrowserCount = normalizeBrowserCount(settingsManager.get().browser.browserCount);

  await createWindow();

  automationManager = new SeoAutomationManager(
    proxyManager,
    browserManager,
    ensureBrowserCount
  );

  registerIpc({
    browserManager,
    automationManager
  });

  await ensureBrowserCount(activeBrowserCount);

  // Keep Alive is automatic after a matched Google result. Retain the
  // enhanced scroll/link behavior but remove the unrelated settings UI.
  const browserSettings = settingsManager.get().browser;
  browserManager.configureKeepAlive(
    browserSettings.keepAliveIntervalSec * 1000,
    browserSettings.keepAliveMaxHops,
    true
  );

  logger.info('application', 'ProxyDesk SEO Tracker Lite ready.');
}

app.whenReady().then(() => {
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
  automationManager?.stop();
  void browserManager?.destroyAll();
});

process.on('uncaughtException', (err) => {
  logger.error('application', `Uncaught exception: ${err.stack ?? err.message}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error('application', `Unhandled rejection: ${String(reason)}`);
});
