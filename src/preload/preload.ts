import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi } from '../shared/types/ipc';

// Keep this runtime object self-contained because the preload runs sandboxed.
const IPC_CHANNELS = {
  browserGetAll: 'browser:getAll',
  browserSetBounds: 'browser:setBounds',
  browserStateChanged: 'browser:stateChanged',
  automationGetState: 'automation:getState',
  automationStart: 'automation:start',
  automationStop: 'automation:stop',
  automationRunNow: 'automation:runNow',
  automationStateChanged: 'automation:stateChanged',
  automationSeoResult: 'automation:seoResult'
} as const;

const api: AppApi = {
  browser: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetAll),
    setBounds: (id, bounds) => ipcRenderer.invoke(IPC_CHANNELS.browserSetBounds, id, bounds),
    onStateChanged: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC_CHANNELS.browserStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.browserStateChanged, listener);
    }
  },
  automation: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.automationGetState),
    start: (config) => ipcRenderer.invoke(IPC_CHANNELS.automationStart, config),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.automationStop),
    runNow: () => ipcRenderer.invoke(IPC_CHANNELS.automationRunNow),
    onStateChanged: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC_CHANNELS.automationStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.automationStateChanged, listener);
    },
    onSeoResult: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.automationSeoResult, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.automationSeoResult, listener);
    }
  }
};

contextBridge.exposeInMainWorld('app', api);
