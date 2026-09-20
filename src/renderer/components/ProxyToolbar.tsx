import { useState } from 'react';
import { useAppStore, type ActivePanel } from '../stores/appStore';
import { COUNTRIES } from '../../shared/constants/countries';
import { ProxyImportDialog } from './ProxyImportDialog';

export function ProxyToolbar(): JSX.Element {
  const selectedCountry = useAppStore((s) => s.selectedCountry);
  const setSelectedCountry = useAppStore((s) => s.setSelectedCountry);
  const isReloading = useAppStore((s) => s.isReloadingProxies);
  const setReloading = useAppStore((s) => s.setReloading);
  const reloadProgress = useAppStore((s) => s.reloadProgress);
  const setReloadProgress = useAppStore((s) => s.setReloadProgress);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
  const pushToast = useAppStore((s) => s.pushToast);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const activePanel = useAppStore((s) => s.activePanel);

  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const keepAliveOn = settings.browser.keepAliveEnabled;

  const [importOpen, setImportOpen] = useState(false);

  async function toggleKeepAlive() {
    const nextEnabled = !keepAliveOn;
    const updated = await window.app.settings.update({ browser: { ...settings.browser, keepAliveEnabled: nextEnabled } });
    setSettings(updated);
    pushToast(
      nextEnabled
        ? `Keep sessions alive turned ON — browsers will auto-scroll every ${settings.browser.keepAliveIntervalSec}s while you're away.`
        : 'Keep sessions alive turned OFF.',
      'info'
    );
  }

  async function assignProxies() {
    setReloading(true);
    setReloadProgress(null);
    try {
      const summary = await window.app.proxy.reload(selectedCountry);
      setReloadSummary(summary);

      if (summary.found === 0) {
        // Zero proxies found just means nothing has been imported yet —
        // there's no discovery step any more, so this is the only way the
        // pool can be empty.
        pushToast('No proxies to assign yet — use Import Proxies to add your own list.', 'info');
      } else {
        const assignedCount = summary.assignments.filter((a) => a.proxy).length;
        // With "Validate proxies before assigning" off (Settings > Proxy),
        // reload() skips the connectivity check entirely, so summary.working
        // stays 0 even though assignment itself succeeded — showing
        // "0/750 working" there would read as a failure when nothing
        // actually failed, just that the check was deliberately skipped.
        pushToast(
          settings.proxy.validationEnabled
            ? `Assign complete — ${summary.working}/${summary.found} working, ` +
                `${assignedCount}/${summary.assignments.length} browsers assigned.`
            : `Assign complete (validation skipped) — ${assignedCount}/${summary.assignments.length} browsers assigned.`,
          'success'
        );
      }
    } catch (err) {
      pushToast(`Proxy assign failed: ${(err as Error).message}`, 'error');
    } finally {
      setReloading(false);
      setReloadProgress(null);
    }
  }

  async function rotateNow() {
    setReloading(true);
    try {
      const summary = await window.app.proxy.rotateNow(selectedCountry);
      setReloadSummary(summary);
      pushToast(
        `Proxy rotation complete — ${summary.assignments.filter((a) => a.proxy).length}/${summary.assignments.length} browsers reassigned.`,
        'success'
      );
    } catch (err) {
      pushToast(`Proxy rotation failed: ${(err as Error).message}`, 'error');
    } finally {
      setReloading(false);
    }
  }

  async function validateAll() {
    pushToast('Validating all known proxies…');
    const proxies = await window.app.proxy.validateAll();
    useAppStore.getState().setProxies(proxies);
    pushToast(`Validation complete — ${proxies.filter((p) => p.status === 'working').length} working.`, 'success');
  }

  async function replaceAllFailed() {
    const browsers = Object.values(useAppStore.getState().browsers);
    const failed = browsers.filter((b) => b.connectionStatus === 'proxy-failed' || !b.proxy);
    for (const b of failed) {
      await window.app.proxy.replaceFailed(b.id);
    }
    pushToast(`Replacement attempted for ${failed.length} browser(s).`, 'info');
  }

  function nav(panel: ActivePanel) {
    setActivePanel(panel);
  }

  return (
    <div className="proxy-toolbar">
      <div className="proxy-toolbar__group">
        <label htmlFor="country-select">Country</label>
        <select
          id="country-select"
          value={selectedCountry ?? ''}
          onChange={(e) => setSelectedCountry(e.target.value || null)}
        >
          <option value="">Any Country</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="proxy-toolbar__group">
        <button className="btn-primary" disabled={isReloading} onClick={() => void assignProxies()}>
          {isReloading
            ? reloadProgress
              ? `Checking ${reloadProgress.checked}/${reloadProgress.total}…`
              : 'Assigning…'
            : '↻ Assign Proxies'}
        </button>
        <button onClick={() => setImportOpen(true)}>Import Proxies</button>
        <button onClick={() => void rotateNow()} disabled={isReloading}>Rotate Now</button>
        <button onClick={() => void validateAll()}>Validate All</button>
        <button onClick={() => void replaceAllFailed()}>Replace Failed</button>
      </div>

      <div className="proxy-toolbar__group">
        <button onClick={() => void window.app.browser.reloadAll()}>Reload All Browsers</button>
        <button onClick={() => void window.app.browser.stopAll()}>Stop All</button>
        <button
          className={keepAliveOn ? 'btn-primary' : ''}
          title="Auto-scrolls every browser periodically so sites don't log you out while you're away (e.g. tending to a lab experiment). Toggle the interval in Settings."
          onClick={() => void toggleKeepAlive()}
        >
          {keepAliveOn ? '● Keep Alive All: ON' : 'Keep Alive All: OFF'}
        </button>
      </div>

      <nav className="proxy-toolbar__nav">
        <button className={activePanel === 'grid' ? 'active' : ''} onClick={() => nav('grid')}>
          Browsers
        </button>
        <button className={activePanel === 'proxyManager' ? 'active' : ''} onClick={() => nav('proxyManager')}>
          Proxy Manager
        </button>
        <button className={activePanel === 'assignments' ? 'active' : ''} onClick={() => nav('assignments')}>
          Assignments
        </button>
        <button className={activePanel === 'broadcast' ? 'active' : ''} onClick={() => nav('broadcast')}>
          SEO Tracker
        </button>
        <button className={activePanel === 'diagnostics' ? 'active' : ''} onClick={() => nav('diagnostics')}>
          Diagnostics
        </button>
        <button className={activePanel === 'settings' ? 'active' : ''} onClick={() => nav('settings')}>
          Settings
        </button>
      </nav>

      {importOpen && <ProxyImportDialog onClose={() => setImportOpen(false)} />}
    </div>
  );
}
