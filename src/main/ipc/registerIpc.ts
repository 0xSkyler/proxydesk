import { ipcMain, dialog, shell, clipboard, app, BrowserWindow } from 'electron';
import os from 'node:os';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { BrowserBounds } from '../../shared/types/browser';
import type { BrowserManager } from '../BrowserManager';
import type { ProxyManager } from '../ProxyManager';
import type { SettingsManager } from '../SettingsManager';
import type { SeoAutomationManager } from '../SeoAutomationManager';
import { logger } from '../Logger';

export interface IpcDeps {
  browserManager: BrowserManager;
  proxyManager: ProxyManager;
  settingsManager: SettingsManager;
  automationManager: SeoAutomationManager;
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
  const { browserManager, proxyManager, settingsManager, automationManager, getBrowserIds } = deps;

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

  ipcMain.handle(
    IPC_CHANNELS.browserBroadcastSearch,
    async (_e, ids: number[], query: string, targetWebsite: string) => {
      const targets = ids.length > 0 ? ids : getBrowserIds();
      const maxPages = settingsManager.get().browser.seoMaxPages;
      return Promise.all(targets.map((id) => browserManager.broadcastSearch(id, query, targetWebsite, maxPages)));
    }
  );
  ipcMain.handle(IPC_CHANNELS.browserSetKeepAlive, (_e, id: number, enabled: boolean) =>
    browserManager.setBrowserKeepAlive(id, enabled, enabled)
  );
  ipcMain.handle(IPC_CHANNELS.browserSetKeepAliveAll, (_e, enabled: boolean) =>
    browserManager.setKeepAliveAll(enabled, enabled)
  );

  ipcMain.handle(IPC_CHANNELS.proxyReload, async (_e, countryCode: string | null) => {
    if (automationManager.isRunning()) {
      throw new Error('Stop Autonomous SEO before running a manual proxy assignment.');
    }
    const summary = await proxyManager.reload(getBrowserIds(), countryCode);
    // reload() only updates ProxyManager's own bookkeeping — it does not
    // touch each browser's actual Electron session. Without this loop, the
    // UI would show a proxy assigned while that browser's real network
    // traffic kept using whatever it had before (or none at all), which is
    // exactly the gap that made the "Assign Proxies" button not visibly do
    // anything to the browsers themselves.
    for (const assignment of summary.assignments) {
      await browserManager.assignProxy(assignment.browserId, assignment.proxy);
    }
    return summary;
  });
  ipcMain.handle(IPC_CHANNELS.proxyRotateNow, async (_e, countryCode: string | null) => {
    if (automationManager.isRunning()) {
      throw new Error('Use Run Cycle Now or stop Autonomous SEO before manual rotation.');
    }
    const summary = await proxyManager.rotate(getBrowserIds(), countryCode);
    for (const assignment of summary.assignments) {
      await browserManager.assignProxy(assignment.browserId, assignment.proxy);
    }
    return summary;
  });
  ipcMain.handle(IPC_CHANNELS.proxyGetAll, () => proxyManager.getAll());
  ipcMain.handle(IPC_CHANNELS.proxyAssign, async (_e, browserId: number, proxyId: string | null) => {
    await proxyManager.assign(browserId, proxyId);
    // Use the in-memory assignment rather than the redacted list so
    // authenticated proxies retain their real credentials in the session.
    await browserManager.assignProxy(browserId, proxyManager.getAssignment(browserId));
  });
  ipcMain.handle(IPC_CHANNELS.proxyReplaceFailed, async (_e, browserId: number) => {
    const proxy = await proxyManager.replaceFailed(browserId);
    await browserManager.assignProxy(browserId, proxy);
    return proxy;
  });
  ipcMain.handle(IPC_CHANNELS.proxyValidate, (_e, proxyId: string) => proxyManager.validate(proxyId));
  ipcMain.handle(IPC_CHANNELS.proxyValidateAll, () => proxyManager.validateAll());
  ipcMain.handle(IPC_CHANNELS.proxyCheckGoogleTrust, (_e, proxyId: string) => proxyManager.checkGoogleTrustFor(proxyId));
  ipcMain.handle(IPC_CHANNELS.proxyCheckGoogleTrustForWorking, () => proxyManager.checkGoogleTrustForWorking());
  ipcMain.handle(IPC_CHANNELS.proxyImportText, async (_e, text: string) => {
    if (automationManager.isRunning()) {
      throw new Error('Stop Autonomous SEO before replacing the manual proxy pool.');
    }
    const result = await proxyManager.importText(text);
    // A new import replaces the old runtime pool, so stop using any proxy
    // from the previous list immediately.
    for (const id of getBrowserIds()) await browserManager.assignProxy(id, null);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.proxyImportFile, async (_e, filePath: string) => {
    if (automationManager.isRunning()) {
      throw new Error('Stop Autonomous SEO before replacing the manual proxy pool.');
    }
    const result = await proxyManager.importFile(filePath);
    for (const id of getBrowserIds()) await browserManager.assignProxy(id, null);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.proxyExport, (_e, format: 'txt' | 'csv' | 'json') => proxyManager.exportProxies(format));

  ipcMain.handle(IPC_CHANNELS.automationGetState, () => automationManager.getState());
  ipcMain.handle(IPC_CHANNELS.automationStart, (_e, config) => automationManager.start(config));
  ipcMain.handle(IPC_CHANNELS.automationStop, () => automationManager.stop());
  ipcMain.handle(IPC_CHANNELS.automationRunNow, () => automationManager.runNow());

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

  proxyManager.on('reloadProgress', (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.proxyReloadProgress, progress);
    }
  });

  automationManager.on('stateChanged', (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.automationStateChanged, state);
    }
  });

  automationManager.on('seoResult', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.automationSeoResult, payload);
    }
  });
}
