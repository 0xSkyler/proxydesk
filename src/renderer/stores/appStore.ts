import { create } from 'zustand';
import type { BrowserState } from '../../shared/types/browser';
import type { ProxyRecord, ReloadProgress, ReloadProxiesSummary } from '../../shared/types/proxy';
import type { AppSettings } from '../../shared/types/settings';
import { DEFAULT_SETTINGS } from '../../shared/types/settings';
import { BROWSER_IDS } from '../../shared/types/browser';

export type ActivePanel = 'grid' | 'proxyManager' | 'assignments' | 'settings' | 'diagnostics' | 'broadcast';

interface AppStoreState {
  browsers: Record<number, BrowserState>;
  proxies: ProxyRecord[];
  settings: AppSettings;
  selectedCountry: string | null;
  activePanel: ActivePanel;
  lastReloadSummary: ReloadProxiesSummary | null;
  isReloadingProxies: boolean;
  reloadProgress: ReloadProgress | null;
  toasts: Array<{ id: string; message: string; kind: 'info' | 'error' | 'success' }>;
  /** Count of currently-open modal dialogs (Import Proxies, and any future
   * one) rather than a plain boolean, so two modals opening/closing in any
   * order can never leave this stuck "open" or "closed" incorrectly. See
   * openModal/closeModal — always call them in a pair (e.g. open on mount,
   * close on unmount/close), never set this directly. */
  openModalCount: number;

  setBrowsers(list: BrowserState[]): void;
  upsertBrowser(state: BrowserState): void;
  setProxies(list: ProxyRecord[]): void;
  setSettings(settings: AppSettings): void;
  setSelectedCountry(code: string | null): void;
  setActivePanel(panel: ActivePanel): void;
  setReloadSummary(summary: ReloadProxiesSummary): void;
  setReloading(value: boolean): void;
  setReloadProgress(progress: ReloadProgress | null): void;
  pushToast(message: string, kind?: 'info' | 'error' | 'success'): void;
  dismissToast(id: string): void;
  openModal(): void;
  closeModal(): void;
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
  settings: DEFAULT_SETTINGS,
  selectedCountry: null,
  activePanel: 'grid',
  lastReloadSummary: null,
  isReloadingProxies: false,
  reloadProgress: null,
  toasts: [],
  openModalCount: 0,

  setBrowsers: (list) => set({ browsers: Object.fromEntries(list.map((b) => [b.id, b])) }),
  upsertBrowser: (state) => set((s) => ({ browsers: { ...s.browsers, [state.id]: state } })),
  setProxies: (list) => set({ proxies: list }),
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
  setReloadProgress: (progress) => set({ reloadProgress: progress }),
  pushToast: (message, kind = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: `${Date.now()}-${Math.random()}`, message, kind }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openModal: () => set((s) => ({ openModalCount: s.openModalCount + 1 })),
  closeModal: () => set((s) => ({ openModalCount: Math.max(0, s.openModalCount - 1) }))
}));
