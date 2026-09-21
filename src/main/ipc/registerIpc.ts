import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { BrowserBounds } from '../../shared/types/browser';
import type { BrowserManager } from '../BrowserManager';
import type { SeoAutomationManager } from '../SeoAutomationManager';

export interface IpcDeps {
  browserManager: BrowserManager;
  automationManager: SeoAutomationManager;
}

/**
 * Minimal renderer trust boundary for the SEO Tracker Lite build.
 * No arbitrary navigation, manual proxy import/export, diagnostics, settings,
 * cache controls, or Google-trust tools are exposed.
 */
export function registerIpc(deps: IpcDeps): void {
  const { browserManager, automationManager } = deps;

  ipcMain.handle(IPC_CHANNELS.browserGetAll, () => browserManager.getAll());
  ipcMain.handle(
    IPC_CHANNELS.browserSetBounds,
    (_event, id: number, bounds: BrowserBounds) => browserManager.setBounds(id, bounds)
  );

  ipcMain.handle(IPC_CHANNELS.automationGetState, () => automationManager.getState());
  ipcMain.handle(IPC_CHANNELS.automationStart, (_event, config) => automationManager.start(config));
  ipcMain.handle(IPC_CHANNELS.automationStop, () => automationManager.stop());
  ipcMain.handle(IPC_CHANNELS.automationRunNow, () => automationManager.runNow());

  browserManager.on('stateChanged', (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.browserStateChanged, state);
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
