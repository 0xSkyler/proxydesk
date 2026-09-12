import { useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { countryNameForCode } from '../../shared/constants/countries';
import type { ProxyProtocol, ProxyStatus } from '../../shared/types/proxy';

export function ProxyManagerTable(): JSX.Element {
  const proxies = useAppStore((s) => s.proxies);
  const pushToast = useAppStore((s) => s.pushToast);
  const setProxies = useAppStore((s) => s.setProxies);

  const [search, setSearch] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProxyStatus | ''>('');
  const [protocolFilter, setProtocolFilter] = useState<ProxyProtocol | ''>('');
  const [sortByLatency, setSortByLatency] = useState(false);

  const filtered = useMemo(() => {
    let list = proxies.filter((p) => {
      if (search && !`${p.host}:${p.port}`.includes(search)) return false;
      if (countryFilter && p.countryCode !== countryFilter) return false;
      if (statusFilter && p.status !== statusFilter) return false;
      if (protocolFilter && p.protocol !== protocolFilter) return false;
      return true;
    });
    if (sortByLatency) {
      list = [...list].sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
    } else {
      list = [...list].sort((a, b) => b.score - a.score);
    }
    return list;
  }, [proxies, search, countryFilter, statusFilter, protocolFilter, sortByLatency]);

  async function validateOne(id: string) {
    const updated = await window.app.proxy.validate(id);
    setProxies(proxies.map((p) => (p.id === id ? updated : p)));
  }

  async function exportAs(format: 'txt' | 'csv' | 'json') {
    const content = await window.app.proxy.exportProxies(format);
    await window.app.system.copyToClipboard(content);
    pushToast(`Exported ${filtered.length} proxies (${format.toUpperCase()}) copied to clipboard.`, 'success');
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Proxy Manager</h2>
        <div className="panel__actions">
          <button onClick={() => void exportAs('txt')}>Export TXT</button>
          <button onClick={() => void exportAs('csv')}>Export CSV</button>
          <button onClick={() => void exportAs('json')}>Export JSON</button>
        </div>
      </div>

      <div className="filters">
        <input placeholder="Search host:port" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input placeholder="Country code" value={countryFilter} onChange={(e) => setCountryFilter(e.target.value.toUpperCase())} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ProxyStatus | '')}>
          <option value="">Any status</option>
          <option value="working">Working</option>
          <option value="dead">Dead</option>
          <option value="unknown">Unknown</option>
          <option value="checking">Checking</option>
        </select>
        <select value={protocolFilter} onChange={(e) => setProtocolFilter(e.target.value as ProxyProtocol | '')}>
          <option value="">Any protocol</option>
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="socks4">SOCKS4</option>
          <option value="socks5">SOCKS5</option>
        </select>
        <label className="checkbox-label">
          <input type="checkbox" checked={sortByLatency} onChange={(e) => setSortByLatency(e.target.checked)} />
          Sort by latency
        </label>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>IP</th>
            <th>Country</th>
            <th>Protocol</th>
            <th>Latency</th>
            <th>Score</th>
            <th>Status</th>
            <th>Sources</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id}>
              <td>
                {p.host}:{p.port}
              </td>
              <td>{p.countryVerified ? countryNameForCode(p.countryCode) ?? p.countryCode : 'Unverified'}</td>
              <td>{p.protocol.toUpperCase()}</td>
              {/* latencyMs is only absent when this proxy hasn't been
                  validated yet (status 'unknown'/'checking') — it does NOT
                  mean the check timed out, so don't label it that way; a
                  proxy that actually failed on timeout still gets a status
                  of 'dead' with an error, shown in the Status column. */}
              <td>{p.latencyMs != null ? `${p.latencyMs} ms` : p.status === 'unknown' ? 'Not checked' : '—'}</td>
              <td>{p.score}</td>
              <td>
                {p.status === 'working' && <span className="status-ok">✓ Working</span>}
                {p.status === 'dead' && <span className="status-bad">✕ Dead</span>}
                {p.status === 'unknown' && <span className="status-neutral">Unknown</span>}
                {p.status === 'checking' && <span className="status-neutral">Checking…</span>}
              </td>
              <td>{p.sources.join(', ')}</td>
              <td>
                <button onClick={() => void validateOne(p.id)}>Test</button>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No proxies available. Use Import Proxies to add your own list.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
