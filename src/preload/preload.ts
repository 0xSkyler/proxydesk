import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi } from '../shared/ipc';

const IPC = {
  trackerGetState: 'tracker:getState',
  trackerStart: 'tracker:start',
  trackerStop: 'tracker:stop',
  trackerRefreshProxies: 'tracker:refreshProxies',
  trackerStateChanged: 'tracker:stateChanged',
  trackerResult: 'tracker:result',
  browserGetAll: 'browser:getAll',
  browserSetBounds: 'browser:setBounds',
  browserStateChanged: 'browser:stateChanged'
} as const;

const api: AppApi = {
  tracker: {
    getState: () => ipcRenderer.invoke(IPC.trackerGetState),
    start: (config) => ipcRenderer.invoke(IPC.trackerStart, config),
    stop: () => ipcRenderer.invoke(IPC.trackerStop),
    refreshProxies: () => ipcRenderer.invoke(IPC.trackerRefreshProxies),
    onStateChanged: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC.trackerStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC.trackerStateChanged, listener);
    },
    onResult: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, result: Parameters<typeof cb>[0]) => cb(result);
      ipcRenderer.on(IPC.trackerResult, listener);
      return () => ipcRenderer.removeListener(IPC.trackerResult, listener);
    }
  },
  browser: {
    getAll: () => ipcRenderer.invoke(IPC.browserGetAll),
    setBounds: (id, bounds) => ipcRenderer.invoke(IPC.browserSetBounds, id, bounds),
    onStateChanged: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(IPC.browserStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC.browserStateChanged, listener);
    }
  }
};

contextBridge.exposeInMainWorld('app', api);
