import type { BrowserState, BrowserBounds, BroadcastSearchResult } from './browser';
import type { ProxyRecord, ProxyImportResult, ReloadProgress, ReloadProxiesSummary } from './proxy';
import type { AppSettings } from './settings';

/**
 * Typed IPC contract. This is the ONLY surface exposed to the renderer via
 * the preload bridge (window.app.*) — see src/preload/preload.ts.
 * Every channel name below is explicitly whitelisted there; nothing else
 * crosses the context-isolation boundary.
 */

export interface DiagnosticsInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  osVersion: string;
  platform: string;
  arch: string;
  browserCount: number;
  memory: { rssMb: number; totalMb: number };
  online: boolean;
}

export interface IpCheckResult {
  browserId: number;
  ip?: string;
  error?: string;
  checkedAt: string;
}

export interface AppApi {
  browser: {
    getAll(): Promise<BrowserState[]>;
    navigate(id: number, url: string): Promise<void>;
    reload(id: number): Promise<void>;
    stop(id: number): Promise<void>;
    goBack(id: number): Promise<void>;
    goForward(id: number): Promise<void>;
    reloadAll(): Promise<void>;
    stopAll(): Promise<void>;
    clearCookies(id: number): Promise<void>;
    clearCache(id: number): Promise<void>;
    openDevTools(id: number): Promise<void>;
    setBounds(id: number, bounds: BrowserBounds): Promise<void>;
    setActive(id: number): Promise<void>;
    checkIp(id: number): Promise<IpCheckResult>;
    checkAllIps(): Promise<IpCheckResult[]>;
    restart(id: number): Promise<void>;
    broadcastSearch(ids: number[], query: string, targetWebsite: string): Promise<BroadcastSearchResult[]>;
    setKeepAlive(id: number, enabled: boolean): Promise<void>;
    setKeepAliveAll(enabled: boolean): Promise<void>;
    onStateChanged(cb: (state: BrowserState) => void): () => void;
  };
  proxy: {
    reload(countryCode: string | null): Promise<ReloadProxiesSummary>;
    rotateNow(countryCode: string | null): Promise<ReloadProxiesSummary>;
    getAll(): Promise<ProxyRecord[]>;
    assign(browserId: number, proxyId: string | null): Promise<void>;
    replaceFailed(browserId: number): Promise<ProxyRecord | null>;
    validate(proxyId: string): Promise<ProxyRecord>;
    validateAll(): Promise<ProxyRecord[]>;
    checkGoogleTrust(proxyId: string): Promise<ProxyRecord>;
    checkGoogleTrustForWorking(): Promise<ProxyRecord[]>;
    importText(text: string): Promise<ProxyImportResult>;
    importFile(filePath: string): Promise<ProxyImportResult>;
    exportProxies(format: 'txt' | 'csv' | 'json'): Promise<string>;
    onAssignmentsChanged(cb: (summary: ReloadProxiesSummary) => void): () => void;
    onReloadProgress(cb: (progress: ReloadProgress) => void): () => void;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(partial: Partial<AppSettings>): Promise<AppSettings>;
    reset(): Promise<AppSettings>;
  };
  system: {
    getDiagnostics(): Promise<DiagnosticsInfo>;
    openLogsFolder(): Promise<void>;
    pickProxyFile(): Promise<string | null>;
    copyToClipboard(text: string): Promise<void>;
  };
}

export const IPC_CHANNELS = {
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

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',

  systemDiagnostics: 'system:diagnostics',
  systemOpenLogs: 'system:openLogs',
  systemPickProxyFile: 'system:pickProxyFile',
  systemClipboard: 'system:clipboard'
} as const;
