import { ipcMain, dialog, shell, clipboard, app, BrowserWindow } from 'electron';
import os from 'node:os';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { BrowserBounds } from '../../shared/types/browser';
import type { BrowserManager } from '../BrowserManager';
import type { ProxyManager } from '../ProxyManager';
import type { SettingsManager } from '../SettingsManager';
import { logger } from '../Logger';

export interface IpcDeps {
  browserManager: BrowserManager;
  proxyManager: ProxyManager;
  settingsManager: SettingsManager;
  getBrowserIds: () => number[];
}

/**
 * Registers every IPC handler the preload bridge is allowed to call.
 * This is the single trust boundary in the app: the renderer never gets
 * direct access to Node/Electron APIs (contextIsolation + no
 * nodeIntegration + sandbox — see main.ts), only these narrow, typed
 * request/response and event channels.
 */
export function registerIpc(deps: IpcDeps): void {
  const { browserManager, proxyManager, settingsManager, getBrowserIds } = deps;

  ipcMain.handle(IPC_CHANNELS.browserGetAll, () => browserManager.getAll());
  ipcMain.handle(IPC_CHANNELS.browserNavigate, (_e, id: number, url: string) => browserManager.navigate(id, url));
  ipcMain.handle(IPC_CHANNELS.browserReload, (_e, id: number) => browserManager.reload(id));
  ipcMain.handle(IPC_CHANNELS.browserStop, (_e, id: number) => browserManager.stop(id));
  ipcMain.handle(IPC_CHANNELS.browserBack, (_e, id: number) => browserManager.goBack(id));
  ipcMain.handle(IPC_CHANNELS.browserForward, (_e, id: number) => browserManager.goForward(id));
  ipcMain.handle(IPC_CHANNELS.browserReloadAll, () => browserManager.reloadAll());
  ipcMain.handle(IPC_CHANNELS.browserStopAll, () => browserManager.stopAll());
  ipcMain.handle(IPC_CHANNELS.browserClearCookies, (_e, id: number) => browserManager.clearCookies(id));
  ipcMain.handle(IPC_CHANNELS.browserClearCache, (_e, id: number) => browserManager.clearCache(id));
  ipcMain.handle(IPC_CHANNELS.browserDevTools, (_e, id: number) => browserManager.openDevTools(id));
  ipcMain.handle(IPC_CHANNELS.browserRestart, (_e, id: number) => browserManager.restart(id));
  ipcMain.handle(IPC_CHANNELS.browserSetActive, (_e, id: number) => browserManager.setActive(id));
  ipcMain.handle(IPC_CHANNELS.browserSetBounds, (_e, id: number, bounds: BrowserBounds) =>
    browserManager.setBounds(id, bounds)
  );
  ipcMain.handle(IPC_CHANNELS.browserCheckIp, async (_e, id: number) => {
    const settings = settingsManager.get();
    const result = await browserManager.checkIp(id, settings.proxy.ipCheckUrl);
    return { browserId: id, ...result, checkedAt: new Date().toISOString() };
  });
  ipcMain.handle(IPC_CHANNELS.browserCheckAllIps, async () => {
    const settings = settingsManager.get();
    const ids = getBrowserIds();
    return Promise.all(
      ids.map(async (id) => {
        const result = await browserManager.checkIp(id, settings.proxy.ipCheckUrl);
        return { browserId: id, ...result, checkedAt: new Date().toISOString() };
      })
    );
  });

  ipcMain.handle(IPC_CHANNELS.proxyReload, (_e, countryCode: string | null) =>
    proxyManager.reload(getBrowserIds(), countryCode)
  );
  ipcMain.handle(IPC_CHANNELS.proxyGetAll, () => proxyManager.getAll());
  ipcMain.handle(IPC_CHANNELS.proxyAssign, async (_e, browserId: number, proxyId: string | null) => {
    await proxyManager.assign(browserId, proxyId);
    const proxy = proxyId ? proxyManager.getAll().find((p) => p.id === proxyId) ?? null : null;
    await browserManager.assignProxy(browserId, proxy);
  });
  ipcMain.handle(IPC_CHANNELS.proxyReplaceFailed, async (_e, browserId: number) => {
    const proxy = await proxyManager.replaceFailed(browserId);
    await browserManager.assignProxy(browserId, proxy);
    return proxy;
  });
  ipcMain.handle(IPC_CHANNELS.proxyValidate, (_e, proxyId: string) => proxyManager.validate(proxyId));
  ipcMain.handle(IPC_CHANNELS.proxyValidateAll, () => proxyManager.validateAll());
  ipcMain.handle(IPC_CHANNELS.proxyImportText, (_e, text: string) => proxyManager.importText(text));
  ipcMain.handle(IPC_CHANNELS.proxyImportFile, (_e, filePath: string) => proxyManager.importFile(filePath));
  ipcMain.handle(IPC_CHANNELS.proxyExport, (_e, format: 'txt' | 'csv' | 'json') => proxyManager.exportProxies(format));
  ipcMain.handle(IPC_CHANNELS.proxyProviderHealth, () => proxyManager.getProviderHealth());

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => settingsManager.get());
  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (_e, partial) => settingsManager.update(partial));
  ipcMain.handle(IPC_CHANNELS.settingsReset, () => settingsManager.reset());

  ipcMain.handle(IPC_CHANNELS.systemDiagnostics, () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    osVersion: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    browserCount: getBrowserIds().length,
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      totalMb: Math.round(os.totalmem() / 1024 / 1024)
    },
    online: true
  }));
  ipcMain.handle(IPC_CHANNELS.systemOpenLogs, () => shell.openPath(logger.logsFolderPath()));
  ipcMain.handle(IPC_CHANNELS.systemPickProxyFile, async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Proxy Lists', extensions: ['txt', 'csv'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle(IPC_CHANNELS.systemClipboard, (_e, text: string) => clipboard.writeText(text));

  browserManager.on('stateChanged', (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.browserStateChanged, state);
    }
  });

  proxyManager.on('assignmentsChanged', (summary) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.proxyAssignmentsChanged, summary);
    }
  });
}
