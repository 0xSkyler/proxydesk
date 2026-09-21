import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

export function useAppData(): void {
  const setBrowsers = useAppStore((state) => state.setBrowsers);
  const upsertBrowser = useAppStore((state) => state.upsertBrowser);
  const setAutomation = useAppStore((state) => state.setAutomation);
  const setResult = useAppStore((state) => state.setResult);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      window.app.browser.getAll(),
      window.app.automation.getState()
    ]).then(([browsers, automation]) => {
      if (cancelled) return;
      setBrowsers(browsers);
      setAutomation(automation);
    });

    const offBrowser = window.app.browser.onStateChanged(upsertBrowser);
    const offAutomation = window.app.automation.onStateChanged(setAutomation);
    const offResult = window.app.automation.onSeoResult(({ result }) => setResult(result));

    return () => {
      cancelled = true;
      offBrowser();
      offAutomation();
      offResult();
    };
  }, [setBrowsers, upsertBrowser, setAutomation, setResult]);
}
