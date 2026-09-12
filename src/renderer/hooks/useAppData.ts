import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

/**
 * Bootstraps the renderer's store from the main process and subscribes to
 * push events (browser state changes, proxy assignment changes) so the UI
 * stays live without polling.
 */
export function useAppData(): void {
  const setBrowsers = useAppStore((s) => s.setBrowsers);
  const upsertBrowser = useAppStore((s) => s.upsertBrowser);
  const setProxies = useAppStore((s) => s.setProxies);
  const setSettings = useAppStore((s) => s.setSettings);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
  const setReloadProgress = useAppStore((s) => s.setReloadProgress);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [browsers, proxies, settings] = await Promise.all([
        window.app.browser.getAll(),
        window.app.proxy.getAll(),
        window.app.settings.get()
      ]);
      if (cancelled) return;
      setBrowsers(browsers);
      setProxies(proxies);
      setSettings(settings);
    }

    void load();

    const offBrowser = window.app.browser.onStateChanged((state) => upsertBrowser(state));
    const offProxy = window.app.proxy.onAssignmentsChanged((summary) => {
      setReloadSummary(summary);
      setReloadProgress(null);
      void window.app.proxy.getAll().then(setProxies);
    });
    const offProgress = window.app.proxy.onReloadProgress((progress) => setReloadProgress(progress));

    return () => {
      cancelled = true;
      offBrowser();
      offProxy();
      offProgress();
    };
  }, [setBrowsers, upsertBrowser, setProxies, setSettings, setReloadSummary, setReloadProgress]);
}
