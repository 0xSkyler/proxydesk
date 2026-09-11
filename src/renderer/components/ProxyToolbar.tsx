import { useState } from 'react';
import { useAppStore, type ActivePanel } from '../stores/appStore';
import { COUNTRIES } from '../../shared/constants/countries';
import { ProxyImportDialog } from './ProxyImportDialog';
import { PublicProxyWarningDialog } from './PublicProxyWarningDialog';

export function ProxyToolbar(): JSX.Element {
  const selectedCountry = useAppStore((s) => s.selectedCountry);
  const setSelectedCountry = useAppStore((s) => s.setSelectedCountry);
  const isReloading = useAppStore((s) => s.isReloadingProxies);
  const setReloading = useAppStore((s) => s.setReloading);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
  const pushToast = useAppStore((s) => s.pushToast);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const activePanel = useAppStore((s) => s.activePanel);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);

  const [importOpen, setImportOpen] = useState(false);
  const [pendingPublicEnable, setPendingPublicEnable] = useState(false);
  const [pendingAggregatedEnable, setPendingAggregatedEnable] = useState(false);

  async function reloadProxies() {
    setReloading(true);
    try {
      const summary = await window.app.proxy.reload(selectedCountry);
      setReloadSummary(summary);

      if (summary.found === 0) {
        // Zero proxies found is expected, not an error, when there's no
        // source configured yet — public providers are off by default (see
        // the security warning) and nothing has been imported. Say that
        // plainly instead of a generic "0 found" that reads like a failure.
        const noSourcesEnabled = !settings.proxy.publicProvidersEnabled && !settings.proxy.aggregatedListsEnabled;
        const countrySelected = Boolean(selectedCountry);
        pushToast(
          noSourcesEnabled
            ? 'No proxies found — no public source is enabled (toggle "Public proxies" or "Aggregated lists" above, or use Import Proxies to add your own).'
            : countrySelected
              ? 'No proxies found for that country. The aggregated lists provider has no country data, so only "Public proxies" can match a specific country — try "Any Country", or use Import Proxies to add your own.'
              : 'No proxies found from any enabled provider right now. Try again shortly, or use Import Proxies to add your own.',
          'info'
        );
      } else {
        pushToast(
          `Proxy reload complete — found ${summary.found}, working ${summary.working}, ` +
            `${summary.assignments.filter((a) => a.proxy).length}/${summary.assignments.length} browsers assigned.`,
          'success'
        );
      }
      for (const err of summary.providerErrors) {
        pushToast(`Provider "${err.provider}" failed: ${err.reason}`, 'error');
      }
    } catch (err) {
      pushToast(`Proxy reload failed: ${(err as Error).message}`, 'error');
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

  function togglePublicProviders(enabled: boolean) {
    if (enabled && !settings.publicProxyWarningAcknowledged) {
      setPendingPublicEnable(true);
      return;
    }
    void window.app.settings.update({ proxy: { ...settings.proxy, publicProvidersEnabled: enabled } }).then(setSettings);
  }

  function toggleAggregatedLists(enabled: boolean) {
    // Same untrusted-source risk as public providers, so it's gated behind
    // the same acknowledgment rather than a second dialog.
    if (enabled && !settings.publicProxyWarningAcknowledged) {
      setPendingAggregatedEnable(true);
      return;
    }
    void window.app.settings.update({ proxy: { ...settings.proxy, aggregatedListsEnabled: enabled } }).then(setSettings);
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
        <button className="btn-primary" disabled={isReloading} onClick={() => void reloadProxies()}>
          {isReloading ? 'Reloading…' : '↻ Reload Proxies'}
        </button>
        <button onClick={() => setImportOpen(true)}>Import Proxies</button>
        <button onClick={() => void validateAll()}>Validate All</button>
        <button onClick={() => void replaceAllFailed()}>Replace Failed</button>
      </div>

      <div className="proxy-toolbar__group">
        <button onClick={() => void window.app.browser.reloadAll()}>Reload All Browsers</button>
        <button onClick={() => void window.app.browser.stopAll()}>Stop All</button>
      </div>

      <div className="proxy-toolbar__group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.publicProvidersEnabled}
            onChange={(e) => togglePublicProviders(e.target.checked)}
          />
          Public proxies
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.aggregatedListsEnabled}
            onChange={(e) => toggleAggregatedLists(e.target.checked)}
          />
          Aggregated lists
        </label>
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
        <button className={activePanel === 'diagnostics' ? 'active' : ''} onClick={() => nav('diagnostics')}>
          Diagnostics
        </button>
        <button className={activePanel === 'settings' ? 'active' : ''} onClick={() => nav('settings')}>
          Settings
        </button>
      </nav>

      {importOpen && <ProxyImportDialog onClose={() => setImportOpen(false)} />}
      {pendingPublicEnable && (
        <PublicProxyWarningDialog
          onCancel={() => setPendingPublicEnable(false)}
          onContinue={() => {
            setPendingPublicEnable(false);
            void window.app.settings
              .update({
                publicProxyWarningAcknowledged: true,
                proxy: { ...settings.proxy, publicProvidersEnabled: true }
              })
              .then(setSettings);
          }}
        />
      )}
      {pendingAggregatedEnable && (
        <PublicProxyWarningDialog
          onCancel={() => setPendingAggregatedEnable(false)}
          onContinue={() => {
            setPendingAggregatedEnable(false);
            void window.app.settings
              .update({
                publicProxyWarningAcknowledged: true,
                proxy: { ...settings.proxy, aggregatedListsEnabled: true }
              })
              .then(setSettings);
          }}
        />
      )}
    </div>
  );
}
