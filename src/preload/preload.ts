import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi } from '../shared/types/ipc';

/**
 * The ONLY bridge between renderer and main. `contextIsolation: true` +
 * `nodeIntegration: false` + `sandbox: true` (see main.ts) mean the
 * renderer has zero direct access to Node or unrestricted Electron APIs;
 * everything it can do is explicitly whitelisted here as `window.app.*`,
 * matching the `AppApi` contract in src/shared/types/ipc.ts one-to-one.
 * No channel name is ever constructed dynamically from renderer input.
 *
 * IPC_CHANNELS is duplicated here (rather than imported from
 * ../shared/types/ipc) deliberately: Electron's sandboxed preload
 * environment (`sandbox: true`) cannot resolve `require()` of sibling
 * relative files — only a preload that is fully self-contained (plus
 * `require('electron')`, which is specially shimmed) loads correctly.
 * Importing a value from a relative path here compiles to a `require()`
 * that silently fails in the sandboxed preload context, `window.app`
 * never gets exposed, and the renderer crashes on its first read of it —
 * which is exactly the blank/black-screen bug this fixed. The type-only
 * `import type { AppApi }` below is erased at compile time and has no
 * runtime require, so it stays safe to import normally. Keep this object
 * in sync with IPC_CHANNELS in ../shared/types/ipc.ts if channels change.
 */
const IPC_CHANNELS = {
  browserGetAll: 'browser:getAll',
  browserNavigate: 'browser:navigate',
  browserReload: 'browser:reload',
  browserStop: 'browser:stop',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReloadAll: 'browser:reloadAll',
  browserStopAll: 'browser:stopAll',
  browserClearCookies: 'browser:clearCookies',
  browserClearCache: 'browser:clearCache',
  browserDevTools: 'browser:devTools',
  browserSetBounds: 'browser:setBounds',
  browserSetActive: 'browser:setActive',
  browserCheckIp: 'browser:checkIp',
  browserCheckAllIps: 'browser:checkAllIps',
  browserRestart: 'browser:restart',
  browserBroadcastSearch: 'browser:broadcastSearch',
  browserSetKeepAlive: 'browser:setKeepAlive',
  browserSetKeepAliveAll: 'browser:setKeepAliveAll',
  browserStateChanged: 'browser:stateChanged',

  proxyReload: 'proxy:reload',
  proxyRotateNow: 'proxy:rotateNow',
  proxyGetAll: 'proxy:getAll',
  proxyAssign: 'proxy:assign',
  proxyReplaceFailed: 'proxy:replaceFailed',
  proxyValidate: 'proxy:validate',
  proxyValidateAll: 'proxy:validateAll',
  proxyCheckGoogleTrust: 'proxy:checkGoogleTrust',
  proxyCheckGoogleTrustForWorking: 'proxy:checkGoogleTrustForWorking',
  proxyImportText: 'proxy:importText',
  proxyImportFile: 'proxy:importFile',
  proxyExport: 'proxy:export',
  proxyAssignmentsChanged: 'proxy:assignmentsChanged',
  proxyReloadProgress: 'proxy:reloadProgress',

  automationGetState: 'automation:getState',
  automationStart: 'automation:start',
  automationStop: 'automation:stop',
  automationRunNow: 'automation:runNow',
  automationStateChanged: 'automation:stateChanged',
  automationSeoResult: 'automation:seoResult',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',

  systemDiagnostics: 'system:diagnostics',
  systemOpenLogs: 'system:openLogs',
  systemPickProxyFile: 'system:pickProxyFile',
  systemClipboard: 'system:clipboard'
} as const;
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
    broadcastSearch: (ids, query, targetWebsite) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserBroadcastSearch, ids, query, targetWebsite),
    setKeepAlive: (id, enabled) => ipcRenderer.invoke(IPC_CHANNELS.browserSetKeepAlive, id, enabled),
    setKeepAliveAll: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.browserSetKeepAliveAll, enabled),
    onStateChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC_CHANNELS.browserStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.browserStateChanged, listener);
    }
  },
  proxy: {
    reload: (countryCode) => ipcRenderer.invoke(IPC_CHANNELS.proxyReload, countryCode),
    rotateNow: (countryCode) => ipcRenderer.invoke(IPC_CHANNELS.proxyRotateNow, countryCode),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.proxyGetAll),
    assign: (browserId, proxyId) => ipcRenderer.invoke(IPC_CHANNELS.proxyAssign, browserId, proxyId),
    replaceFailed: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.proxyReplaceFailed, browserId),
    validate: (proxyId) => ipcRenderer.invoke(IPC_CHANNELS.proxyValidate, proxyId),
    validateAll: () => ipcRenderer.invoke(IPC_CHANNELS.proxyValidateAll),
    checkGoogleTrust: (proxyId) => ipcRenderer.invoke(IPC_CHANNELS.proxyCheckGoogleTrust, proxyId),
    checkGoogleTrustForWorking: () => ipcRenderer.invoke(IPC_CHANNELS.proxyCheckGoogleTrustForWorking),
    importText: (text) => ipcRenderer.invoke(IPC_CHANNELS.proxyImportText, text),
    importFile: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.proxyImportFile, filePath),
    exportProxies: (format) => ipcRenderer.invoke(IPC_CHANNELS.proxyExport, format),
    onAssignmentsChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, summary: Parameters<typeof cb>[0]) => cb(summary);
      ipcRenderer.on(IPC_CHANNELS.proxyAssignmentsChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.proxyAssignmentsChanged, listener);
    },
    onReloadProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, progress: Parameters<typeof cb>[0]) => cb(progress);
      ipcRenderer.on(IPC_CHANNELS.proxyReloadProgress, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.proxyReloadProgress, listener);
    }
  },
  automation: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.automationGetState),
    start: (config) => ipcRenderer.invoke(IPC_CHANNELS.automationStart, config),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.automationStop),
    runNow: () => ipcRenderer.invoke(IPC_CHANNELS.automationRunNow),
    onStateChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC_CHANNELS.automationStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.automationStateChanged, listener);
    },
    onSeoResult: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.automationSeoResult, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.automationSeoResult, listener);
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
