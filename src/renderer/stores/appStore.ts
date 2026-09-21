import { create } from 'zustand';
import type { BrowserState, BroadcastSearchResult } from '../../shared/types/browser';
import type { SeoAutomationState } from '../../shared/types/automation';

interface AppStoreState {
  browsers: Record<number, BrowserState>;
  automation: SeoAutomationState | null;
  results: Record<number, BroadcastSearchResult>;
  toasts: Array<{ id: string; message: string; kind: 'info' | 'error' | 'success' }>;

  setBrowsers(list: BrowserState[]): void;
  upsertBrowser(state: BrowserState): void;
  setAutomation(state: SeoAutomationState): void;
  setResult(result: BroadcastSearchResult): void;
  clearResults(): void;
  pushToast(message: string, kind?: 'info' | 'error' | 'success'): void;
  dismissToast(id: string): void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  browsers: {},
  automation: null,
  results: {},
  toasts: [],

  setBrowsers: (list) => set({ browsers: Object.fromEntries(list.map((browser) => [browser.id, browser])) }),
  upsertBrowser: (state) =>
    set((current) => ({ browsers: { ...current.browsers, [state.id]: state } })),
  setAutomation: (automation) => set({ automation }),
  setResult: (result) =>
    set((current) => ({ results: { ...current.results, [result.browserId]: result } })),
  clearResults: () => set({ results: {} }),
  pushToast: (message, kind = 'info') =>
    set((current) => ({
      toasts: [
        ...current.toasts,
        { id: `${Date.now()}-${Math.random()}`, message, kind }
      ]
    })),
  dismissToast: (id) =>
    set((current) => ({ toasts: current.toasts.filter((toast) => toast.id !== id) }))
}));
