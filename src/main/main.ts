import path from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { IPC } from '../shared/ipc';
import type { BrowserBounds, BrowserState, TrackerConfig, TrackerResult, TrackerState } from '../shared/tracker';
import { ProxyScrapeService } from './ProxyScrapeService';
import { SeoBrowserManager } from './SeoBrowserManager';
import { SeoTrackerManager } from './SeoTrackerManager';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
const browsers = new SeoBrowserManager();
const proxySource = new ProxyScrapeService();
const tracker = new SeoTrackerManager(browsers, proxySource);

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0e1117',
    title: 'ProxyDesk SEO Tracker',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  browsers.attachWindow(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function registerIpc(): void {
  ipcMain.handle(IPC.trackerGetState, () => tracker.getState());
  ipcMain.handle(IPC.trackerStart, (_event, config: TrackerConfig) => tracker.start(config));
  ipcMain.handle(IPC.trackerStop, () => tracker.stop());
  ipcMain.handle(IPC.trackerRefreshProxies, () => tracker.refreshProxies());
  ipcMain.handle(IPC.browserGetAll, () => browsers.getAll());
  ipcMain.handle(IPC.browserSetBounds, (_event, id: number, bounds: BrowserBounds) => {
    browsers.setBounds(id, bounds);
  });

  browsers.on('stateChanged', (state: BrowserState) => send(IPC.browserStateChanged, state));
  tracker.on('stateChanged', (state: TrackerState) => send(IPC.trackerStateChanged, state));
  tracker.on('result', (result: TrackerResult) => send(IPC.trackerResult, result));
}

async function bootstrap(): Promise<void> {
  registerIpc();
  await createWindow();
  await browsers.syncCount(4);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  void bootstrap().catch((err) => {
    console.error('ProxyDesk SEO Tracker startup failed:', err);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('before-quit', () => {
  tracker.stop();
  void browsers.destroyAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
