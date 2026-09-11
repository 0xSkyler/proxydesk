import { useEffect, useState } from 'react';
import { useAppStore } from './stores/appStore';
import { useAppData } from './hooks/useAppData';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { BrowserGrid } from './components/BrowserGrid';
import { ProxyToolbar } from './components/ProxyToolbar';
import { ProxyManagerTable } from './components/ProxyManagerTable';
import { BrowserAssignmentView } from './components/BrowserAssignmentView';
import { Settings } from './components/Settings';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { BroadcastSearchPanel } from './components/BroadcastSearchPanel';
import { Toasts } from './components/Toasts';
import type { DiagnosticsInfo } from '../shared/types/ipc';

function useTheme(): void {
  const theme = useAppStore((s) => s.settings.application.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = prefersDark ? 'dark' : 'light';
    } else {
      root.dataset.theme = theme;
    }
  }, [theme]);
}

function StatusBar(): JSX.Element {
  const [memory, setMemory] = useState<DiagnosticsInfo['memory'] | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => window.app.system.getDiagnostics().then((d) => mounted && setMemory(d.memory));
    void load();
    const interval = setInterval(load, 8000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const summary = useAppStore((s) => s.lastReloadSummary);
  const providerHealth = useAppStore((s) => s.providerHealth);
  const anyProviderDown = providerHealth.some((h) => h.lastError);

  return (
    <footer className="status-bar">
      <span>RAM: {memory ? `${memory.rssMb} MB` : '—'}</span>
      <span>
        {summary
          ? `Last reload: ${summary.working}/${summary.found} working, ${
              summary.assignments.filter((a) => a.proxy).length
            }/${summary.assignments.length} assigned`
          : 'No proxy reload yet'}
      </span>
      <span className={anyProviderDown ? 'status-bad' : 'status-ok'}>
        {anyProviderDown ? 'One or more providers reporting errors' : 'All providers healthy'}
      </span>
    </footer>
  );
}

export default function App(): JSX.Element {
  useAppData();
  useTheme();

  const activePanel = useAppStore((s) => s.activePanel);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 300);
    return () => clearTimeout(timer);
  }, []);

  useKeyboardShortcuts({
    onReloadSelected: () => void window.app.browser.reload(useAppStore.getState().browsers[1]?.id ?? 1),
    onReloadAll: () => void window.app.browser.reloadAll(),
    onOpenProxyManager: () => setActivePanel('proxyManager'),
    onReloadProxies: () => void window.app.proxy.reload(useAppStore.getState().selectedCountry),
    onOpenSettings: () => setActivePanel('settings')
  });

  if (!ready) {
    return (
      <div className="startup-screen">
        <h1>ProxyDesk</h1>
        <p>Initializing…</p>
        <ul>
          <li>✓ Configuration</li>
          <li>✓ Proxy providers</li>
          <li>✓ Proxy discovery</li>
          <li>✓ Browser sessions</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ProxyToolbar />
      <main className="app-shell__main">
        {/* BrowserGrid stays mounted (never display:none) even when another
            panel is active, so its ResizeObservers keep firing and its
            BrowserPanels keep reporting real bounds to the main process.
            When another panel is showing, this wrapper is pushed off-screen
            with a fixed position instead of hidden, so the underlying
            BrowserViews (real Chromium content, positioned independently of
            React's DOM by the main process) move off-screen with it rather
            than floating on top of whatever panel is visible. */}
        <div className={activePanel === 'grid' ? 'grid-wrapper' : 'grid-wrapper grid-wrapper--offscreen'}>
          <BrowserGrid />
        </div>
        {activePanel === 'proxyManager' && <ProxyManagerTable />}
        {activePanel === 'assignments' && <BrowserAssignmentView />}
        {activePanel === 'settings' && <Settings />}
        {activePanel === 'diagnostics' && <DiagnosticsPanel />}
        {activePanel === 'broadcast' && <BroadcastSearchPanel />}
      </main>
      <StatusBar />
      <Toasts />
    </div>
  );
}
