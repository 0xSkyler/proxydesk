import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { BROWSER_IDS } from '../../shared/types/browser';
import type { BroadcastSearchResult, BroadcastSearchStatus } from '../../shared/types/browser';

const STATUS_LABEL: Record<BroadcastSearchStatus, string> = {
  matched: 'Found — clicked result',
  'no-match': 'Target not found',
  blocked: 'Google challenge / consent page',
  error: 'Error'
};

const STATUS_CLASS: Record<BroadcastSearchStatus, string> = {
  matched: 'status-ok',
  'no-match': 'status-neutral',
  blocked: 'status-bad',
  error: 'status-bad'
};

export function BroadcastSearchPanel(): JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const browsers = useAppStore((s) => s.browsers);
  const ids = BROWSER_IDS.slice(0, settings.browser.browserCount);
  const pushToast = useAppStore((s) => s.pushToast);

  const [query, setQuery] = useState('');
  const [targetWebsite, setTargetWebsite] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set(ids));
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<number, BroadcastSearchResult>>({});

  function toggleId(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run() {
    if (!query.trim()) {
      pushToast('Enter a Google search keyword first.', 'error');
      return;
    }
    if (!targetWebsite.trim()) {
      pushToast('Enter the target website or domain first.', 'error');
      return;
    }

    const targetIds = ids.filter((id) => selectedIds.has(id));
    if (targetIds.length === 0) {
      pushToast('Select at least one browser.', 'error');
      return;
    }

    setRunning(true);
    try {
      const outcomes = await window.app.browser.broadcastSearch(targetIds, query.trim(), targetWebsite.trim());
      setResults((prev) => {
        const next = { ...prev };
        for (const outcome of outcomes) next[outcome.browserId] = outcome;
        return next;
      });

      const matched = outcomes.filter((outcome) => outcome.status === 'matched').length;
      const blocked = outcomes.filter((outcome) => outcome.status === 'blocked').length;
      pushToast(
        `SEO run complete — ${matched}/${outcomes.length} found and opened the target` +
          (blocked > 0 ? `, ${blocked} Google challenge page(s)` : ''),
        matched > 0 ? 'success' : 'info'
      );
    } catch (err) {
      pushToast(`SEO run failed: ${(err as Error).message}`, 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>SEO Tracker</h2>
      </div>

      <p className="muted">
        Each selected browser opens Google, searches the keyword, scans up to {settings.browser.seoMaxPages} result
        page(s), and matches the target by hostname. When found, ProxyDesk clicks the organic Google result itself,
        waits for the target page to load, and starts enhanced Keep Alive in that browser.
      </p>

      <div className="provider-form" style={{ maxWidth: 560 }}>
        <label>
          Google keyword / search query
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. garment inventory safety stock Bangladesh"
          />
        </label>
        <label>
          Target website or domain
          <input
            type="text"
            value={targetWebsite}
            onChange={(e) => setTargetWebsite(e.target.value)}
            placeholder="e.g. appareldiary.com"
          />
        </label>
      </div>

      <div className="panel__section">
        <h3>Run on browsers</h3>
        <div className="filters">
          {ids.map((id) => (
            <label key={id} className="checkbox-label">
              <input type="checkbox" checked={selectedIds.has(id)} onChange={() => toggleId(id)} />
              {browsers[id]?.label ?? `Browser ${id}`}
            </label>
          ))}
        </div>
        <div className="panel__actions">
          <button onClick={() => setSelectedIds(new Set(ids))} disabled={running}>Select All</button>
          <button onClick={() => setSelectedIds(new Set())} disabled={running}>Select None</button>
          <button className="btn-primary" onClick={() => void run()} disabled={running}>
            {running ? 'Searching Google…' : 'Run SEO Search'}
          </button>
        </div>
      </div>

      <div className="panel__section">
        <h3>Results</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Browser</th>
              <th>Status</th>
              <th>Position</th>
              <th>Landed on</th>
              <th>Keep Alive</th>
              <th>Ran at</th>
            </tr>
          </thead>
          <tbody>
            {ids.filter((id) => results[id]).map((id) => {
              const result = results[id];
              return (
                <tr key={id}>
                  <td>{browsers[id]?.label ?? `Browser ${id}`}</td>
                  <td className={STATUS_CLASS[result.status]}>
                    {STATUS_LABEL[result.status]}{result.error ? ` — ${result.error}` : ''}
                  </td>
                  <td>
                    {result.position != null
                      ? `#${result.position} (page ${result.resultPage ?? '—'})`
                      : '—'}
                  </td>
                  <td>{result.landedUrl ?? '—'}</td>
                  <td>{result.keepAliveStarted ? 'Started' : '—'}</td>
                  <td>{new Date(result.ranAt).toLocaleTimeString()}</td>
                </tr>
              );
            })}
            {ids.every((id) => !results[id]) && (
              <tr><td colSpan={6} className="muted">No SEO runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
