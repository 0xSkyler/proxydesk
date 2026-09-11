import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { BROWSER_IDS } from '../../shared/types/browser';
import type { BroadcastSearchResult, BroadcastSearchStatus } from '../../shared/types/browser';

const STATUS_LABEL: Record<BroadcastSearchStatus, string> = {
  matched: 'Found — opened',
  'no-match': 'Not found in results',
  blocked: 'Blocked by Google (unusual traffic / consent page)',
  error: 'Error'
};

const STATUS_CLASS: Record<BroadcastSearchStatus, string> = {
  matched: 'status-ok',
  'no-match': 'status-neutral',
  blocked: 'status-bad',
  error: 'status-bad'
};

/**
 * Central command panel: run the same (or a per-browser) Google search
 * across the selected browser workspaces, and open the first result whose
 * title or snippet contains the given match text. Each browser uses its
 * own already-assigned proxy, so this is one search fanned out across
 * workspaces rather than a single browser searching many times.
 *
 * This performs exactly one search and, at most, one follow-up navigation
 * per browser — it never clicks through multiple results or repeats a
 * search on its own.
 */
export function BroadcastSearchPanel(): JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const browsers = useAppStore((s) => s.browsers);
  const ids = BROWSER_IDS.slice(0, settings.browser.browserCount);
  const pushToast = useAppStore((s) => s.pushToast);

  const [query, setQuery] = useState('');
  const [matchText, setMatchText] = useState('');
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
      pushToast('Enter a search term first.', 'error');
      return;
    }
    const targetIds = ids.filter((id) => selectedIds.has(id));
    if (targetIds.length === 0) {
      pushToast('Select at least one browser to run this on.', 'error');
      return;
    }

    setRunning(true);
    try {
      const effectiveMatch = matchText.trim() || query.trim();
      const outcomes = await window.app.browser.broadcastSearch(targetIds, query.trim(), effectiveMatch);
      setResults((prev) => {
        const next = { ...prev };
        for (const o of outcomes) next[o.browserId] = o;
        return next;
      });

      const matched = outcomes.filter((o) => o.status === 'matched').length;
      const blocked = outcomes.filter((o) => o.status === 'blocked').length;
      pushToast(
        `Search complete — ${matched}/${outcomes.length} opened a match` +
          (blocked > 0 ? `, ${blocked} blocked by Google` : ''),
        matched > 0 ? 'success' : 'info'
      );
    } catch (err) {
      pushToast(`Broadcast search failed: ${(err as Error).message}`, 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Broadcast Search</h2>
      </div>

      <p className="muted">
        Runs one Google search on each selected browser (using that browser&rsquo;s own proxy), then opens the first
        result whose title or text contains the match phrase. Leave &ldquo;Match text&rdquo; blank to just use the
        search term itself, or narrow it — e.g. search <em>hcl 20% concentration supplier</em> but only open a
        result that actually mentions <em>20%</em>.
      </p>

      <div className="provider-form" style={{ maxWidth: 480 }}>
        <label>
          Search term
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. hcl 20% concentration supplier"
          />
        </label>
        <label>
          Match text (optional)
          <input
            type="text"
            value={matchText}
            onChange={(e) => setMatchText(e.target.value)}
            placeholder="Defaults to the search term above"
          />
        </label>
      </div>

      <div className="panel__section">
        <h3>Run on</h3>
        <div className="filters">
          {ids.map((id) => (
            <label key={id} className="checkbox-label">
              <input type="checkbox" checked={selectedIds.has(id)} onChange={() => toggleId(id)} />
              {browsers[id]?.label ?? `Browser ${id}`}
            </label>
          ))}
        </div>
        <div className="panel__actions">
          <button
            onClick={() => setSelectedIds(new Set(ids))}
            disabled={running}
          >
            Select All
          </button>
          <button onClick={() => setSelectedIds(new Set())} disabled={running}>
            Select None
          </button>
          <button className="btn-primary" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Run Search'}
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
              <th>Landed on</th>
              <th>Ran at</th>
            </tr>
          </thead>
          <tbody>
            {ids
              .filter((id) => results[id])
              .map((id) => {
                const r = results[id];
                return (
                  <tr key={id}>
                    <td>{browsers[id]?.label ?? `Browser ${id}`}</td>
                    <td className={STATUS_CLASS[r.status]}>
                      {STATUS_LABEL[r.status]}
                      {r.error ? ` — ${r.error}` : ''}
                    </td>
                    <td>{r.landedUrl ?? '—'}</td>
                    <td>{new Date(r.ranAt).toLocaleTimeString()}</td>
                  </tr>
                );
              })}
            {ids.every((id) => !results[id]) && (
              <tr>
                <td colSpan={4} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
