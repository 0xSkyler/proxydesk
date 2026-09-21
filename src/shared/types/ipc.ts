import type { BrowserBounds, BrowserState } from './browser';
import type {
  SeoAutomationConfig,
  SeoAutomationResult,
  SeoAutomationState
} from './automation';

export interface AppApi {
  browser: {
    getAll(): Promise<BrowserState[]>;
    setBounds(id: number, bounds: BrowserBounds): Promise<void>;
    onStateChanged(cb: (state: BrowserState) => void): () => void;
  };
  automation: {
    getState(): Promise<SeoAutomationState>;
    start(config: SeoAutomationConfig): Promise<SeoAutomationState>;
    stop(): Promise<SeoAutomationState>;
    runNow(): Promise<SeoAutomationState>;
    onStateChanged(cb: (state: SeoAutomationState) => void): () => void;
    onSeoResult(cb: (payload: SeoAutomationResult) => void): () => void;
  };
}

export const IPC_CHANNELS = {
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
