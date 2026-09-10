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
  const setProviderHealth = useAppStore((s) => s.setProviderHealth);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [browsers, proxies, settings, health] = await Promise.all([
        window.app.browser.getAll(),
        window.app.proxy.getAll(),
        window.app.settings.get(),
        window.app.proxy.getProviderHealth()
      ]);
      if (cancelled) return;
      setBrowsers(browsers);
      setProxies(proxies);
      setSettings(settings);
      setProviderHealth(health);
    }

    void load();

    const offBrowser = window.app.browser.onStateChanged((state) => upsertBrowser(state));
    const offProxy = window.app.proxy.onAssignmentsChanged((summary) => {
      setReloadSummary(summary);
      void window.app.proxy.getAll().then(setProxies);
    });

    return () => {
      cancelled = true;
      offBrowser();
      offProxy();
    };
  }, [setBrowsers, upsertBrowser, setProxies, setSettings, setReloadSummary, setProviderHealth]);
}
