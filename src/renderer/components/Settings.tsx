import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { AppSettings, CustomProviderConfig, GridLayout, Theme } from '../../shared/types/settings';

export function Settings(): JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const pushToast = useAppStore((s) => s.pushToast);
  const [newProvider, setNewProvider] = useState<Partial<CustomProviderConfig>>({
    method: 'GET',
    headers: {},
    responseArrayPath: 'proxies',
    enabled: true
  });

  async function apply(partial: Partial<AppSettings>) {
    const updated = await window.app.settings.update(partial);
    setSettings(updated);
  }

  async function resetAll() {
    const updated = await window.app.settings.reset();
    setSettings(updated);
    pushToast('Settings reset to defaults.', 'info');
  }

  function addCustomProvider() {
    if (!newProvider.name || !newProvider.apiUrl) {
      pushToast('Provider name and API URL are required.', 'error');
      return;
    }
    const provider: CustomProviderConfig = {
      id: `custom-${Date.now()}`,
      name: newProvider.name,
      apiUrl: newProvider.apiUrl,
      method: newProvider.method === 'POST' ? 'POST' : 'GET',
      headers: newProvider.headers ?? {},
      countryParam: newProvider.countryParam,
      responseArrayPath: newProvider.responseArrayPath ?? 'proxies',
      enabled: true
    };
    void apply({ customProviders: [...settings.customProviders, provider] });
    setNewProvider({ method: 'GET', headers: {}, responseArrayPath: 'proxies', enabled: true });
  }

  function removeCustomProvider(id: string) {
    void apply({ customProviders: settings.customProviders.filter((p) => p.id !== id) });
  }

  return (
    <div className="panel settings-panel">
      <div className="panel__header">
        <h2>Settings</h2>
        <button onClick={() => void resetAll()}>Reset to Defaults</button>
      </div>

      <section>
        <h3>Browser</h3>
        <label>
          Number of browsers
          <input
            type="number"
            min={1}
            max={10}
            value={settings.browser.browserCount}
            onChange={(e) =>
              void apply({ browser: { ...settings.browser, browserCount: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Browser grid
          <select
            value={settings.browser.gridLayout}
            onChange={(e) => void apply({ browser: { ...settings.browser, gridLayout: e.target.value as GridLayout } })}
          >
            <option value="1x10">1 column</option>
            <option value="2x5">2 columns</option>
            <option value="5x2">5 columns</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.browser.persistSessions}
            onChange={(e) => void apply({ browser: { ...settings.browser, persistSessions: e.target.checked } })}
          />
          Persist browser sessions
        </label>
        <label>
          Start page
          <input
            value={settings.browser.startPage}
            onChange={(e) => void apply({ browser: { ...settings.browser, startPage: e.target.value } })}
          />
        </label>
        <label>
          Custom user agent (optional)
          <input
            value={settings.browser.userAgent}
            onChange={(e) => void apply({ browser: { ...settings.browser, userAgent: e.target.value } })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.browser.hardwareAcceleration}
            onChange={(e) =>
              void apply({ browser: { ...settings.browser, hardwareAcceleration: e.target.checked } })
            }
          />
          Hardware acceleration (restart required)
        </label>
      </section>

      <section>
        <h3>Proxy</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.autoLoadOnStartup}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, autoLoadOnStartup: e.target.checked } })}
          />
          Auto-load proxies on startup
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.autoReplaceFailed}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, autoReplaceFailed: e.target.checked } })}
          />
          Auto-replace failed proxies
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.validationEnabled}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, validationEnabled: e.target.checked } })}
          />
          Proxy validation
        </label>
        <label>
          Validation timeout (ms)
          <input
            type="number"
            min={1000}
            max={60000}
            value={settings.proxy.validationTimeoutMs}
            onChange={(e) =>
              void apply({ proxy: { ...settings.proxy, validationTimeoutMs: Number(e.target.value) } })
            }
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.allowProxyReuse}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, allowProxyReuse: e.target.checked } })}
          />
          Allow proxy reuse
        </label>
        <label>
          Max concurrent proxy checks
          <input
            type="number"
            min={1}
            max={50}
            value={settings.proxy.maxConcurrentChecks}
            onChange={(e) =>
              void apply({ proxy: { ...settings.proxy, maxConcurrentChecks: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Max candidates validated per reload
          <input
            type="number"
            min={0}
            max={5000}
            value={settings.proxy.maxCandidatesPerReload}
            onChange={(e) =>
              void apply({ proxy: { ...settings.proxy, maxCandidatesPerReload: Number(e.target.value) } })
            }
          />
        </label>
        <p className="muted" style={{ marginTop: -6, marginBottom: 0 }}>
          Caps how many public/aggregated-list proxies get checked per reload (a random sample, not always the same
          ones) so a large source list doesn&rsquo;t turn one reload into a multi-hour validation queue. Imported and
          custom-provider proxies are never capped.
        </p>
        <label>
          IP check URL
          <input
            value={settings.proxy.ipCheckUrl}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, ipCheckUrl: e.target.value } })}
          />
        </label>
        <label>
          Proxy rotation
          <select
            value={settings.proxy.rotationInterval}
            onChange={(e) =>
              void apply({
                proxy: { ...settings.proxy, rotationInterval: e.target.value as typeof settings.proxy.rotationInterval }
              })
            }
          >
            <option value="off">Off</option>
            <option value="10m">Every 10 minutes</option>
            <option value="30m">Every 30 minutes</option>
            <option value="60m">Every 60 minutes</option>
            <option value="manual">Manual only</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Proxy Providers</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.publicProvidersEnabled}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, publicProvidersEnabled: e.target.checked } })}
          />
          Enable public proxy providers
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.aggregatedListsEnabled}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, aggregatedListsEnabled: e.target.checked } })}
          />
          Enable aggregated public lists (~70 sources, no country filtering)
        </label>

        <h4>Custom / API Providers</h4>
        <ul className="provider-list">
          {settings.customProviders.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong> — {p.apiUrl}
              <button onClick={() => removeCustomProvider(p.id)}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="provider-form">
          <input
            placeholder="Provider name"
            value={newProvider.name ?? ''}
            onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
          />
          <input
            placeholder="API URL"
            value={newProvider.apiUrl ?? ''}
            onChange={(e) => setNewProvider((p) => ({ ...p, apiUrl: e.target.value }))}
          />
          <input
            placeholder="Country query param (optional)"
            value={newProvider.countryParam ?? ''}
            onChange={(e) => setNewProvider((p) => ({ ...p, countryParam: e.target.value }))}
          />
          <input
            placeholder="Response array path (e.g. data.proxies)"
            value={newProvider.responseArrayPath ?? ''}
            onChange={(e) => setNewProvider((p) => ({ ...p, responseArrayPath: e.target.value }))}
          />
          <button onClick={addCustomProvider}>Add Provider</button>
        </div>
        <p className="muted">
          API keys for custom providers should be supplied via request headers configured here, sourced from your own
          secure storage — never commit credentials into source control (see .env.example).
        </p>
      </section>

      <section>
        <h3>Performance</h3>
        <label>
          Maximum concurrent proxy checks
          <input
            type="number"
            min={1}
            max={50}
            value={settings.performance.maxConcurrentProxyChecks}
            onChange={(e) =>
              void apply({ performance: { ...settings.performance, maxConcurrentProxyChecks: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Maximum concurrent page loads
          <input
            type="number"
            min={1}
            max={10}
            value={settings.performance.maxConcurrentPageLoads}
            onChange={(e) =>
              void apply({ performance: { ...settings.performance, maxConcurrentPageLoads: Number(e.target.value) } })
            }
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.performance.suspendInactiveBrowsers}
            onChange={(e) =>
              void apply({ performance: { ...settings.performance, suspendInactiveBrowsers: e.target.checked } })
            }
          />
          Suspend inactive browsers to save memory
        </label>
      </section>

      <section>
        <h3>Application</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.application.startMinimized}
            onChange={(e) => void apply({ application: { ...settings.application, startMinimized: e.target.checked } })}
          />
          Start minimized
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.application.startWithWindows}
            onChange={(e) =>
              void apply({ application: { ...settings.application, startWithWindows: e.target.checked } })
            }
          />
          Start with Windows
        </label>
        <label>
          Theme
          <select
            value={settings.application.theme}
            onChange={(e) => void apply({ application: { ...settings.application, theme: e.target.value as Theme } })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.application.notificationsEnabled}
            onChange={(e) =>
              void apply({ application: { ...settings.application, notificationsEnabled: e.target.checked } })
            }
          />
          Notifications
        </label>
        <button onClick={() => void window.app.system.openLogsFolder()}>Open Logs Folder</button>
      </section>

      <p className="muted disclaimer">
        A proxy does not guarantee anonymity or security. Traffic may be observable by the proxy operator. Free
        public proxies may be unreliable or malicious — avoid entering sensitive credentials through untrusted
        proxies.
      </p>
    </div>
  );
}
