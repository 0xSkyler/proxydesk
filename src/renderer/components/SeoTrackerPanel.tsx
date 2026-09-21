import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';

export function SeoTrackerPanel(): JSX.Element {
  const automation = useAppStore((state) => state.automation);
  const browsers = useAppStore((state) => state.browsers);
  const results = useAppStore((state) => state.results);
  const clearResults = useAppStore((state) => state.clearResults);
  const pushToast = useAppStore((state) => state.pushToast);

  const [query, setQuery] = useState('');
  const [targetWebsite, setTargetWebsite] = useState('');
  const [intervalSec, setIntervalSec] = useState(600);
  const [browserCount, setBrowserCount] = useState(10);
  const [maxPages, setMaxPages] = useState(20);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!automation) return;
    if (automation.query) setQuery(automation.query);
    if (automation.targetWebsite) setTargetWebsite(automation.targetWebsite);
    setIntervalSec(automation.intervalSec);
    setBrowserCount(automation.browserCount);
    setMaxPages(automation.maxPages);
  }, [automation]);

  const running = automation?.running ?? false;
  const nextCycle = automation?.nextCycleAt
    ? new Date(automation.nextCycleAt).toLocaleTimeString()
    : '—';

  const resultRows = useMemo(
    () =>
      Object.values(results)
        .sort((a, b) => a.browserId - b.browserId),
    [results]
  );

  async function start(): Promise<void> {
    if (!query.trim() || !targetWebsite.trim()) {
      pushToast('Enter both a keyword and target website.', 'error');
      return;
    }

    clearResults();
    setStarting(true);
    try {
      await window.app.automation.start({
        query: query.trim(),
        targetWebsite: targetWebsite.trim(),
        intervalSec,
        browserCount,
        maxPages
      });
      pushToast('SEO Tracker started.', 'success');
    } catch (err) {
      pushToast(`Could not start SEO Tracker: ${(err as Error).message}`, 'error');
    } finally {
      setStarting(false);
    }
  }

  async function stop(): Promise<void> {
    await window.app.automation.stop();
    pushToast('SEO Tracker stopped.', 'info');
  }

  async function runNow(): Promise<void> {
    try {
      await window.app.automation.runNow();
      pushToast('Rotation cycle requested.', 'info');
    } catch (err) {
      pushToast((err as Error).message, 'error');
    }
  }

  return (
    <section className="seo-tracker">
      <div className="seo-tracker__title">
        <div>
          <h1>ProxyDesk SEO Tracker Lite</h1>
          <p>
            ProxyScrape API → validation → live proxy assignment → Google page scan →
            article click → Keep Alive → rotation.
          </p>
        </div>
        <span className={running || starting ? 'tracker-pill tracker-pill--on' : 'tracker-pill'}>
          {starting
            ? 'STARTING'
            : running
              ? (automation?.cycleInProgress ? 'RUNNING' : 'WAITING')
              : 'STOPPED'}
        </span>
      </div>

      <div className="tracker-controls">
        <label>
          Keyword
          <input
            value={query}
            disabled={running}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="rmg cutting"
          />
        </label>

        <label>
          Target website
          <input
            value={targetWebsite}
            disabled={running}
            onChange={(event) => setTargetWebsite(event.target.value)}
            placeholder="appareldiary.com"
          />
        </label>

        <label>
          Browsers
          <input
            type="number"
            min={1}
            max={100}
            value={browserCount}
            disabled={running}
            onChange={(event) => setBrowserCount(Number(event.target.value))}
          />
        </label>

        <label>
          Max Google pages
          <input
            type="number"
            min={1}
            max={100}
            value={maxPages}
            disabled={running}
            onChange={(event) => setMaxPages(Number(event.target.value))}
          />
        </label>

        <label>
          Rotation interval (sec)
          <input
            type="number"
            min={30}
            max={86400}
            value={intervalSec}
            disabled={running}
            onChange={(event) => setIntervalSec(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="tracker-actions">
        <button className="btn-primary" disabled={running || starting} onClick={() => void start()}>
          {starting ? 'Starting…' : 'Start SEO Tracker'}
        </button>
        <button disabled={!running || automation?.cycleInProgress} onClick={() => void runNow()}>
          Rotate / Run Now
        </button>
        <button disabled={!running} onClick={() => void stop()}>
          Stop
        </button>
      </div>

      <div className="tracker-status">
        <span>Source <strong>ProxyScrape Free API</strong></span>
        <span>Cycle <strong>{automation?.cycleNumber ?? 0}</strong></span>
        <span>Fetched <strong>{automation?.fetchedProxies ?? 0}</strong></span>
        <span>
          Validated <strong>{automation?.checkedProxies ?? 0}/{automation?.totalProxies ?? 0}</strong>
        </span>
        <span>Live <strong>{automation?.liveProxies ?? 0}</strong></span>
        <span>
          Assigned <strong>{automation?.assignedBrowsers ?? 0}/{automation?.browserIds.length ?? 0}</strong>
        </span>
        <span>Next rotation <strong>{nextCycle}</strong></span>
      </div>

      {automation?.lastError && (
        <div className="tracker-error">{automation.lastError}</div>
      )}

      <div className="tracker-note">
        Google pages are scanned sequentially up to the configured limit. Each page is
        stopped as soon as its DOM is ready, so detection does not wait for complete page
        loading. Keep Alive starts automatically only after the matched article opens.
      </div>

      <div className="tracker-results">
        <h2>SEO results</h2>
        <table>
          <thead>
            <tr>
              <th>Browser</th>
              <th>Proxy</th>
              <th>Status</th>
              <th>Google page</th>
              <th>Article</th>
              <th>Keep Alive</th>
            </tr>
          </thead>
          <tbody>
            {resultRows.map((result) => {
              const browser = browsers[result.browserId];
              const proxy = browser?.proxy;
              return (
                <tr key={result.browserId}>
                  <td>Browser {result.browserId}</td>
                  <td>{proxy ? `${proxy.host}:${proxy.port}` : '—'}</td>
                  <td className={result.status === 'matched' ? 'status-ok' : result.status === 'error' || result.status === 'blocked' ? 'status-bad' : ''}>
                    {result.status}
                    {result.error ? ` — ${result.error}` : ''}
                  </td>
                  <td>{result.resultPage ?? '—'}</td>
                  <td title={result.landedUrl}>{result.matchedTitle ?? result.landedUrl ?? '—'}</td>
                  <td>{result.keepAliveStarted ? 'Active' : '—'}</td>
                </tr>
              );
            })}
            {resultRows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">No completed browser searches yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
