
import { useAppStore } from '../stores/appStore';
import { countryNameForCode } from '../../shared/constants/countries';
import { BROWSER_IDS } from '../../shared/types/browser';

export function BrowserAssignmentView(): JSX.Element {
  const browsers = useAppStore((s) => s.browsers);
  const settings = useAppStore((s) => s.settings);
  const ids = BROWSER_IDS.slice(0, settings.browser.browserCount);
  const pushToast = useAppStore((s) => s.pushToast);

  async function checkAllIps() {
    const results = await window.app.browser.checkAllIps();
    for (const r of results) {
      if (r.error) pushToast(`Browser ${r.browserId}: IP check failed (${r.error})`, 'error');
    }
    pushToast('IP check complete for all browsers.', 'success');
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Browser Assignment Overview</h2>
        <button onClick={() => void checkAllIps()}>Check All IPs</button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Browser</th>
            <th>Proxy</th>
            <th>Country</th>
            <th>Latency</th>
            <th>Detected IP</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const b = browsers[id];
            return (
              <tr key={id}>
                <td>{b?.label ?? `Browser ${id}`}</td>
                <td>{b?.proxy ? `${b.proxy.host}:${b.proxy.port}` : 'No proxy'}</td>
                <td>
                  {b?.proxy?.countryVerified
                    ? countryNameForCode(b.proxy.countryCode) ?? b.proxy.countryCode
                    : b?.proxy
                    ? 'Unverified'
                    : '—'}
                </td>
                <td>{b?.proxy?.latencyMs != null ? `${b.proxy.latencyMs} ms` : '—'}</td>
                <td>{b?.detectedIp ?? '—'}</td>
                <td>{b?.connectionStatus === 'connected' || (b?.proxy && b.connectionStatus !== 'proxy-failed') ? '✓' : '—'}</td>
                <td>
                  <button onClick={() => void window.app.proxy.replaceFailed(id)}>Replace Proxy</button>
                  <button onClick={() => void window.app.browser.checkIp(id)}>Check IP</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
