import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/types/ipc';
import type { AppApi } from '../shared/types/ipc';

/**
 * The ONLY bridge between renderer and main. `contextIsolation: true` +
 * `nodeIntegration: false` + `sandbox: true` (see main.ts) mean the
 * renderer has zero direct access to Node or unrestricted Electron APIs;
 * everything it can do is explicitly whitelisted here as `window.app.*`,
 * matching the `AppApi` contract in src/shared/types/ipc.ts one-to-one.
 * No channel name is ever constructed dynamically from renderer input.
 */
const api: AppApi = {
  browser: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetAll),
    navigate: (id, url) => ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, id, url),
    reload: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserReload, id),
    stop: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserStop, id),
    goBack: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserBack, id),
    goForward: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserForward, id),
    reloadAll: () => ipcRenderer.invoke(IPC_CHANNELS.browserReloadAll),
    stopAll: () => ipcRenderer.invoke(IPC_CHANNELS.browserStopAll),
    clearCookies: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserClearCookies, id),
    clearCache: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserClearCache, id),
    openDevTools: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserDevTools, id),
    setBounds: (id, bounds) => ipcRenderer.invoke(IPC_CHANNELS.browserSetBounds, id, bounds),
    setActive: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserSetActive, id),
    checkIp: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserCheckIp, id),
    checkAllIps: () => ipcRenderer.invoke(IPC_CHANNELS.browserCheckAllIps),
    restart: (id) => ipcRenderer.invoke(IPC_CHANNELS.browserRestart, id),
    onStateChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC_CHANNELS.browserStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.browserStateChanged, listener);
    }
  },
  proxy: {
    reload: (countryCode) => ipcRenderer.invoke(IPC_CHANNELS.proxyReload, countryCode),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.proxyGetAll),
    assign: (browserId, proxyId) => ipcRenderer.invoke(IPC_CHANNELS.proxyAssign, browserId, proxyId),
    replaceFailed: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.proxyReplaceFailed, browserId),
    validate: (proxyId) => ipcRenderer.invoke(IPC_CHANNELS.proxyValidate, proxyId),
    validateAll: () => ipcRenderer.invoke(IPC_CHANNELS.proxyValidateAll),
    importText: (text) => ipcRenderer.invoke(IPC_CHANNELS.proxyImportText, text),
    importFile: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.proxyImportFile, filePath),
    exportProxies: (format) => ipcRenderer.invoke(IPC_CHANNELS.proxyExport, format),
    getProviderHealth: () => ipcRenderer.invoke(IPC_CHANNELS.proxyProviderHealth),
    onAssignmentsChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, summary: Parameters<typeof cb>[0]) => cb(summary);
      ipcRenderer.on(IPC_CHANNELS.proxyAssignmentsChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.proxyAssignmentsChanged, listener);
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (partial) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, partial),
    reset: () => ipcRenderer.invoke(IPC_CHANNELS.settingsReset)
  },
  system: {
    getDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.systemDiagnostics),
    openLogsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.systemOpenLogs),
    pickProxyFile: () => ipcRenderer.invoke(IPC_CHANNELS.systemPickProxyFile),
    copyToClipboard: (text) => ipcRenderer.invoke(IPC_CHANNELS.systemClipboard, text)
  }
};

contextBridge.exposeInMainWorld('app', api);
