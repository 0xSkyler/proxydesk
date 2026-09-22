import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { BrowserManager } from './BrowserManager';
import { ProxyManager } from './ProxyManager';
import { SeoAutomationManager } from './SeoAutomationManager';
import { registerIpc } from './ipc/registerIpc';
import { logger } from './Logger';
import { BROWSER_IDS } from '../shared/types/browser';
import { normalizeBrowserCount } from '../shared/types/automation';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager;
let proxyManager: ProxyManager;
let automationManager: SeoAutomationManager;
let activeBrowserCount = 10;

async function createWindowShell(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: '#0f1115',
    title: 'ProxyDesk SEO Tracker Lite',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  browserManager.attachWindow(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function loadRenderer(): Promise<void> {
  if (!mainWindow) throw new Error('Main window is not available.');
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  mainWindow.show();
}

async function ensureBrowserCount(count: number): Promise<number[]> {
  const normalized = normalizeBrowserCount(count);
  const desired = new Set(BROWSER_IDS.slice(0, normalized));
  const existing = new Set(browserManager.getAll().map((browser) => browser.id));

  for (const id of Array.from(existing)) {
    if (!desired.has(id)) await browserManager.destroyBrowser(id);
  }

  await Promise.all(
    Array.from(desired)
      .filter((id) => !existing.has(id))
      .map((id) =>
        browserManager.createBrowser(id, {
          persistSessions: false,
          startPage: 'about:blank',
          userAgent: ''
        })
      )
  );

  activeBrowserCount = normalized;
  return BROWSER_IDS.slice(0, activeBrowserCount);
}

async function bootstrap(): Promise<void> {
  proxyManager = new ProxyManager();
  await proxyManager.init();

  browserManager = new BrowserManager();
  activeBrowserCount = 10;

  automationManager = new SeoAutomationManager(
    proxyManager,
    browserManager,
    ensureBrowserCount
  );

  // Register IPC before the renderer loads. The previous order allowed the
  // React app to call automation:getState before a handler existed.
  registerIpc({
    browserManager,
    automationManager
  });

  // Build the native shell first, create blank isolated browser sessions,
  // and only then show React. This removes the startup race where the user
  // could click Start while browser creation was still in flight.
  await createWindowShell();
  await ensureBrowserCount(activeBrowserCount);

  // Keep Alive is automatic after a matched Google result.
  browserManager.configureKeepAlive(60_000, 1, false);

  await loadRenderer();
  logger.info('application', 'ProxyDesk SEO Tracker Lite ready.');
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  void bootstrap().catch((err) => {
    logger.error('application', `Fatal startup error: ${(err as Error).stack ?? err}`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void (async () => {
        await createWindowShell();
        await loadRenderer();
      })();
    }
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
