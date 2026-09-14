import { useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { countryNameForCode } from '../../shared/constants/countries';
import type { ProxyProtocol, ProxyStatus } from '../../shared/types/proxy';

export function ProxyManagerTable(): JSX.Element {
  const proxies = useAppStore((s) => s.proxies);
  const browsers = useAppStore((s) => s.browsers);
  const pushToast = useAppStore((s) => s.pushToast);
  const setProxies = useAppStore((s) => s.setProxies);

  // The set of proxy ids actually assigned to a browser right now. Used
  // (instead of `status === 'working'`) to scope the bulk Google-trust
  // check — with "Validate proxies before assigning" turned off, an
  // assigned proxy's status stays 'unknown' forever since it never goes
  // through the connectivity check, so a 'working'-only filter would find
  // nothing to check in exactly that fast-assign workflow.
  const assignedProxyIds = useMemo(
    () => new Set(Object.values(browsers).map((b) => b.proxy?.id).filter((id): id is string => Boolean(id))),
    [browsers]
  );

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

  const [checkingGoogleId, setCheckingGoogleId] = useState<string | null>(null);
  const [checkingGoogleAll, setCheckingGoogleAll] = useState(false);

  async function validateOne(id: string) {
    const updated = await window.app.proxy.validate(id);
    setProxies(proxies.map((p) => (p.id === id ? updated : p)));
  }

  async function checkGoogleTrustOne(id: string) {
    setCheckingGoogleId(id);
    try {
      const updated = await window.app.proxy.checkGoogleTrust(id);
      setProxies(proxies.map((p) => (p.id === id ? updated : p)));
      pushToast(
        updated.googleStatus === 'trusted'
          ? `${updated.host}:${updated.port} — Google served real results. Trusted.`
          : updated.googleStatus === 'blocked'
          ? `${updated.host}:${updated.port} — Google served its "unusual traffic" / CAPTCHA page. Blocked.`
          : `${updated.host}:${updated.port} — could not get a clear read (${updated.googleCheckedAt ? 'request failed' : 'unknown'}).`,
        updated.googleStatus === 'trusted' ? 'success' : updated.googleStatus === 'blocked' ? 'error' : 'info'
      );
    } finally {
      setCheckingGoogleId(null);
    }
  }

  async function checkGoogleTrustForWorking() {
    const assignedCount = assignedProxyIds.size;
    if (assignedCount === 0) {
      pushToast('No proxies assigned to a browser yet — run Assign Proxies first.', 'info');
      return;
    }
    setCheckingGoogleAll(true);
    pushToast(`Checking ${assignedCount} assigned proxy(ies) against Google — this sends a real search through each, so it can take a bit…`);
    try {
      const updated = await window.app.proxy.checkGoogleTrustForWorking();
      setProxies(updated);
      const checked = updated.filter((p) => assignedProxyIds.has(p.id));
      const trusted = checked.filter((p) => p.googleStatus === 'trusted').length;
      const blocked = checked.filter((p) => p.googleStatus === 'blocked').length;
      pushToast(
        `Google trust check complete — ${trusted}/${checked.length} trusted, ${blocked}/${checked.length} blocked by Google.`,
        blocked > 0 ? 'error' : 'success'
      );
    } finally {
      setCheckingGoogleAll(false);
    }
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
          <button
            title="Sends one real Google search through every proxy currently assigned to a browser, and checks whether Google served real results or its unusual-traffic/CAPTCHA page."
            disabled={checkingGoogleAll}
            onClick={() => void checkGoogleTrustForWorking()}
          >
            {checkingGoogleAll ? 'Checking against Google…' : 'Check Google Trust (Assigned)'}
          </button>
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
            <th title="Whether a real Google search through this proxy came back clean or hit Google's unusual-traffic / CAPTCHA page">
              Google
            </th>
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
              <td>
                {p.googleStatus === 'trusted' && <span className="status-ok" title={p.googleCheckedAt}>✓ Trusted</span>}
                {p.googleStatus === 'blocked' && <span className="status-bad" title={p.googleCheckedAt}>✕ Blocked</span>}
                {p.googleStatus === 'unknown' && <span className="status-neutral">Not checked</span>}
              </td>
              <td>{p.sources.join(', ')}</td>
              <td>
                <button onClick={() => void validateOne(p.id)}>Test</button>
                <button
                  title="Send one real Google search through this proxy to see if Google trusts it or serves a CAPTCHA"
                  disabled={checkingGoogleId === p.id}
                  onClick={() => void checkGoogleTrustOne(p.id)}
                >
                  {checkingGoogleId === p.id ? 'Checking…' : 'Check Google'}
                </button>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={9} className="muted">
                No proxies available. Use Import Proxies to add your own list.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
