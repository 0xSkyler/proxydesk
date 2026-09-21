import type {
  BrowserBounds,
  BrowserState,
  ProxyFetchSummary,
  TrackerConfig,
  TrackerResult,
  TrackerState
} from './tracker';

export interface AppApi {
  tracker: {
    getState(): Promise<TrackerState>;
    start(config: TrackerConfig): Promise<TrackerState>;
    stop(): Promise<TrackerState>;
    refreshProxies(): Promise<ProxyFetchSummary>;
    onStateChanged(cb: (state: TrackerState) => void): () => void;
    onResult(cb: (result: TrackerResult) => void): () => void;
  };
  browser: {
    getAll(): Promise<BrowserState[]>;
    setBounds(id: number, bounds: BrowserBounds): Promise<void>;
    onStateChanged(cb: (state: BrowserState) => void): () => void;
  };
}

export const IPC = {
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
