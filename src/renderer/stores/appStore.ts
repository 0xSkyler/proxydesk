import { create } from 'zustand';
import type { BrowserState } from '../../shared/types/browser';
import type { ProxyProviderHealth, ProxyRecord, ReloadProxiesSummary } from '../../shared/types/proxy';
import type { AppSettings } from '../../shared/types/settings';
import { DEFAULT_SETTINGS } from '../../shared/types/settings';
import { BROWSER_IDS } from '../../shared/types/browser';

export type ActivePanel = 'grid' | 'proxyManager' | 'assignments' | 'settings' | 'diagnostics';

interface AppStoreState {
  browsers: Record<number, BrowserState>;
  proxies: ProxyRecord[];
  providerHealth: ProxyProviderHealth[];
  settings: AppSettings;
  selectedCountry: string | null;
  activePanel: ActivePanel;
  lastReloadSummary: ReloadProxiesSummary | null;
  isReloadingProxies: boolean;
  toasts: Array<{ id: string; message: string; kind: 'info' | 'error' | 'success' }>;

  setBrowsers(list: BrowserState[]): void;
  upsertBrowser(state: BrowserState): void;
  setProxies(list: ProxyRecord[]): void;
  setProviderHealth(list: ProxyProviderHealth[]): void;
  setSettings(settings: AppSettings): void;
  setSelectedCountry(code: string | null): void;
  setActivePanel(panel: ActivePanel): void;
  setReloadSummary(summary: ReloadProxiesSummary): void;
  setReloading(value: boolean): void;
  pushToast(message: string, kind?: 'info' | 'error' | 'success'): void;
  dismissToast(id: string): void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  browsers: Object.fromEntries(
    BROWSER_IDS.map((id) => [
      id,
      {
        id,
        label: `Browser ${id}`,
        url: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        proxy: null,
        connectionStatus: 'idle',
        crashCount: 0
      } satisfies BrowserState
    ])
  ),
  proxies: [],
  providerHealth: [],
  settings: DEFAULT_SETTINGS,
  selectedCountry: null,
  activePanel: 'grid',
  lastReloadSummary: null,
  isReloadingProxies: false,
  toasts: [],

  setBrowsers: (list) => set({ browsers: Object.fromEntries(list.map((b) => [b.id, b])) }),
  upsertBrowser: (state) => set((s) => ({ browsers: { ...s.browsers, [state.id]: state } })),
  setProxies: (list) => set({ proxies: list }),
  setProviderHealth: (list) => set({ providerHealth: list }),
  setSettings: (settings) => set({ settings }),
  setSelectedCountry: (code) => set({ selectedCountry: code }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  setReloadSummary: (summary) =>
    set((s) => {
      const browsers = { ...s.browsers };
      for (const a of summary.assignments) {
        if (browsers[a.browserId]) browsers[a.browserId] = { ...browsers[a.browserId], proxy: a.proxy };
      }
      return { lastReloadSummary: summary, browsers };
    }),
  setReloading: (value) => set({ isReloadingProxies: value }),
  pushToast: (message, kind = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: `${Date.now()}-${Math.random()}`, message, kind }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}));
