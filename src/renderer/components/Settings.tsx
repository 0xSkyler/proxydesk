import { useAppStore } from '../stores/appStore';
import type { AppSettings, Theme } from '../../shared/types/settings';
import { MAX_BROWSER_COUNT } from '../../shared/constants';

export function Settings(): JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const pushToast = useAppStore((s) => s.pushToast);

  async function apply(partial: Partial<AppSettings>) {
    const updated = await window.app.settings.update(partial);
    setSettings(updated);
  }

  async function resetAll() {
    const updated = await window.app.settings.reset();
    setSettings(updated);
    pushToast('Settings reset to defaults.', 'info');
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
            max={MAX_BROWSER_COUNT}
            value={settings.browser.browserCount}
            onChange={(e) =>
              void apply({ browser: { ...settings.browser, browserCount: Number(e.target.value) } })
            }
          />
        </label>
        <p className="muted" style={{ marginTop: -6, marginBottom: 0 }}>
          Each browser is a real, separate Chromium session — running many at once is genuinely RAM/CPU heavy.
          Up to {MAX_BROWSER_COUNT} is allowed; scale up gradually and watch RAM in the status bar.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.browser.gridSquareTiles}
            onChange={(e) => void apply({ browser: { ...settings.browser, gridSquareTiles: e.target.checked } })}
          />
          Square tiles (mobile-like) instead of a fixed column count
        </label>
        {!settings.browser.gridSquareTiles && (
          <label>
            Grid columns
            <input
              type="number"
              min={1}
              max={10}
              value={settings.browser.gridColumns}
              onChange={(e) => void apply({ browser: { ...settings.browser, gridColumns: Number(e.target.value) } })}
            />
          </label>
        )}
        <p className="muted" style={{ marginTop: -6, marginBottom: 0 }}>
          Rows follow automatically from Number of browsers ÷ Grid columns — e.g. 6 browsers with 2 columns is a
          2x3 grid, 20 browsers with 2 columns is 2x10. The grid scrolls if it doesn&rsquo;t all fit on screen.
        </p>
        <label>
          Tile size (min height, px)
          <input
            type="number"
            min={80}
            max={900}
            value={settings.browser.tileMinHeight}
            onChange={(e) => void apply({ browser: { ...settings.browser, tileMinHeight: Number(e.target.value) } })}
          />
        </label>
        <p className="muted" style={{ marginTop: -6, marginBottom: 0 }}>
          Browser sessions are always temporary. Cookies, cache, local/site storage and prior browsing state are
          cleared when ProxyDesk closes; persistent browser sessions are disabled.
        </p>
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
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.browser.keepAliveEnabled}
            onChange={(e) => void apply({ browser: { ...settings.browser, keepAliveEnabled: e.target.checked } })}
          />
          Enable enhanced Keep Alive on all browsers
        </label>
        <label>
          Keep-alive interval (seconds)
          <input
            type="number"
            min={5}
            max={3600}
            value={settings.browser.keepAliveIntervalSec}
            onChange={(e) =>
              void apply({ browser: { ...settings.browser, keepAliveIntervalSec: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Central Keep Alive content limit (1-1000 pages per browser)
          <input
            type="number"
            min={1}
            max={1000}
            value={settings.browser.keepAliveMaxHops}
            onChange={(e) =>
              void apply({ browser: { ...settings.browser, keepAliveMaxHops: Number(e.target.value) } })
            }
          />
        </label>
        <p className="muted" style={{ marginTop: -6, marginBottom: 0 }}>
          Each page is slowly scrolled from top to bottom and back to top 6-8 times before Keep Alive follows a
          different same-site content link. The central limit above applies to every browser. Login, account, cart,
          checkout, payment, download, admin and destructive links are excluded.
        </p>
        <label>
          SEO tracker: maximum Google result pages
          <input
            type="number"
            min={1}
            max={10}
            value={settings.browser.seoMaxPages}
            onChange={(e) =>
              void apply({ browser: { ...settings.browser, seoMaxPages: Number(e.target.value) } })
            }
          />
        </label>
      </section>

      <section>
        <h3>Proxy</h3>
        <p className="muted">
          Proxy lists are session-only. ProxyDesk starts with an empty pool every time; upload/paste your proxy.txt
          for the current run. Importing a new list replaces the previous runtime pool.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.autoReplaceFailed}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, autoReplaceFailed: e.target.checked } })}
          />
          Auto-replace proxies blocked by Google (CAPTCHA)
        </label>
        <p className="muted">
          When a browser hits Google&rsquo;s &ldquo;unusual traffic&rdquo; / CAPTCHA page while browsing normally,
          turning this on swaps in a different proxy and retries the page automatically (up to 3 tries in a row
          before giving up and leaving it for a manual &ldquo;Change Proxy&rdquo; click).
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.validationEnabled}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, validationEnabled: e.target.checked } })}
          />
          Validate proxies before assigning
        </label>
        <p className="muted">
          On: every &ldquo;Assign Proxies&rdquo; click first tests each candidate proxy for real connectivity, then
          assigns only the ones that respond. Off: skips that check and assigns straight from whatever you imported
          — turn this off if you already checked the list before importing it, so assignment happens instantly.
          Either way, &ldquo;Check Google Trust&rdquo; in Proxy Manager is separate and always available on demand.
        </p>
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
          IP check URL
          <input
            value={settings.proxy.ipCheckUrl}
            onChange={(e) => void apply({ proxy: { ...settings.proxy, ipCheckUrl: e.target.value } })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.proxy.autoRotationEnabled}
            onChange={(e) =>
              void apply({ proxy: { ...settings.proxy, autoRotationEnabled: e.target.checked } })
            }
          />
          Auto-rotate assigned proxies
        </label>
        {settings.proxy.autoRotationEnabled && (
          <label>
            Proxy rotation interval (seconds)
            <input
              type="number"
              min={5}
              max={86400}
              value={settings.proxy.rotationIntervalSec}
              onChange={(e) =>
                void apply({ proxy: { ...settings.proxy, rotationIntervalSec: Number(e.target.value) } })
              }
            />
          </label>
        )}
        <p className="muted">
          Timed rotation reassigns from the existing proxy pool without running a complete validation sweep on
          every tick. Values below 5 seconds are clamped to 5 seconds.
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
        <label>
          Window width (px, restart required)
          <input
            type="number"
            min={800}
            max={7680}
            value={settings.application.windowWidth}
            onChange={(e) =>
              void apply({ application: { ...settings.application, windowWidth: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Window height (px, restart required)
          <input
            type="number"
            min={600}
            max={4320}
            value={settings.application.windowHeight}
            onChange={(e) =>
              void apply({ application: { ...settings.application, windowHeight: Number(e.target.value) } })
            }
          />
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
