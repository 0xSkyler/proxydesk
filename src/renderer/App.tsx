import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrowserState,
  ProxyFetchSummary,
  ProxyFilter,
  TrackerConfig,
  TrackerState
} from '../shared/tracker';

const DEFAULT_CONFIG: TrackerConfig = {
  query: '',
  target: '',
  maxPages: 5,
  browserCount: 4,
  proxyFilter: 'all'
};

const DEFAULT_STATE: TrackerState = {
  running: false,
  proxiesFetched: 0,
  browserCount: 4,
  results: []
};

export default function App(): JSX.Element {
  const [config, setConfig] = useState<TrackerConfig>(DEFAULT_CONFIG);
  const [tracker, setTracker] = useState<TrackerState>(DEFAULT_STATE);
  const [browsers, setBrowsers] = useState<Record<number, BrowserState>>({});
  const [proxySummary, setProxySummary] = useState<ProxyFetchSummary | null>(null);
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    let active = true;

    void Promise.all([window.app.tracker.getState(), window.app.browser.getAll()]).then(([state, list]) => {
      if (!active) return;
      setTracker(state);
      setBrowsers(Object.fromEntries(list.map((browser) => [browser.id, browser])));
    });

    const offTracker = window.app.tracker.onStateChanged((state) => setTracker(state));
    const offBrowser = window.app.browser.onStateChanged((state) => {
      setBrowsers((current) => ({ ...current, [state.id]: state }));
    });

    return () => {
      active = false;
      offTracker();
      offBrowser();
    };
  }, []);

  async function start(): Promise<void> {
    setMessage('');
    try {
      const state = await window.app.tracker.start(config);
      setTracker(state);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function stop(): Promise<void> {
    const state = await window.app.tracker.stop();
    setTracker(state);
  }

  async function refreshProxies(): Promise<void> {
    setMessage('');
    try {
      const summary = await window.app.tracker.refreshProxies();
      setProxySummary(summary);
      setMessage(`Fetched ${summary.fetched} public proxies from ProxyScrape.`);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  const ids = useMemo(
    () => Array.from({ length: tracker.browserCount }, (_, index) => index + 1),
    [tracker.browserCount]
  );

  return (
    <div className="tracker-app">
      <header className="tracker-header">
        <div>
          <h1>ProxyDesk SEO Tracker</h1>
          <p>Google rank search with live public proxies from ProxyScrape.</p>
        </div>
        <div className={tracker.running ? 'run-badge run-badge--active' : 'run-badge'}>
          {tracker.running ? 'SEARCHING' : 'IDLE'}
        </div>
      </header>

      <section className="controls">
        <label className="field field--wide">
          Search query
          <input
            value={config.query}
            disabled={tracker.running}
            onChange={(event) => setConfig((current) => ({ ...current, query: event.target.value }))}
            placeholder="e.g. rmg cutting"
          />
        </label>

        <label className="field field--wide">
          Target website / site name
          <input
            value={config.target}
            disabled={tracker.running}
            onChange={(event) => setConfig((current) => ({ ...current, target: event.target.value }))}
            placeholder="appareldiary.com or appareldiary"
          />
        </label>

        <label className="field">
          Max Google pages
          <input
            type="number"
            min={1}
            max={20}
            value={config.maxPages}
            disabled={tracker.running}
            onChange={(event) =>
              setConfig((current) => ({ ...current, maxPages: Number(event.target.value) }))
            }
          />
        </label>

        <label className="field">
          Browsers
          <input
            type="number"
            min={1}
            max={20}
            value={config.browserCount}
            disabled={tracker.running}
            onChange={(event) =>
              setConfig((current) => ({ ...current, browserCount: Number(event.target.value) }))
            }
          />
        </label>

        <label className="field">
          Proxy protocol
          <select
            value={config.proxyFilter}
            disabled={tracker.running}
            onChange={(event) =>
              setConfig((current) => ({ ...current, proxyFilter: event.target.value as ProxyFilter }))
            }
          >
            <option value="all">All</option>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks4">SOCKS4</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </label>

        <div className="actions">
          <button className="primary" disabled={tracker.running} onClick={() => void start()}>
            Start SEO Search
          </button>
          <button disabled={!tracker.running} onClick={() => void stop()}>
            Stop
          </button>
          <button disabled={tracker.running} onClick={() => void refreshProxies()}>
            Refresh ProxyScrape
          </button>
        </div>
      </section>

      <section className="summary-row">
        <span>ProxyScrape: {tracker.proxiesFetched || proxySummary?.fetched || 0} proxies</span>
        <span>Browsers: {tracker.browserCount}</span>
        <span>Page limit: {config.maxPages}</span>
        <span>Completed: {tracker.results.length}/{tracker.browserCount}</span>
        {proxySummary && (
          <span>
            HTTP {proxySummary.protocols.http} · HTTPS {proxySummary.protocols.https} · SOCKS4{' '}
            {proxySummary.protocols.socks4} · SOCKS5 {proxySummary.protocols.socks5}
          </span>
        )}
      </section>

      {message && <div className="message">{message}</div>}

      <main className="browser-area">
        <div className="browser-grid">
          {ids.map((id) => (
            <BrowserTile key={id} id={id} state={browsers[id]} />
          ))}
        </div>
      </main>

      <section className="results-panel">
        <h2>Results</h2>
        <div className="results-scroll">
          <table>
            <thead>
              <tr>
                <th>Browser</th>
                <th>Status</th>
                <th>Proxy</th>
                <th>Page</th>
                <th>Position</th>
                <th>Matched URL / Error</th>
              </tr>
            </thead>
            <tbody>
              {tracker.results.map((result) => (
                <tr key={result.browserId}>
                  <td>Browser {result.browserId}</td>
                  <td className={`result-status result-status--${result.status}`}>{result.status}</td>
                  <td>
                    {result.proxy
                      ? `${result.proxy.protocol}://${result.proxy.host}:${result.proxy.port}`
                      : '—'}
                  </td>
                  <td>{result.page ?? '—'}</td>
                  <td>{result.position ?? '—'}</td>
                  <td className="result-detail">{result.matchedUrl ?? result.error ?? '—'}</td>
                </tr>
              ))}
              {tracker.results.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No completed searches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function BrowserTile({ id, state }: { id: number; state?: BrowserState }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);

  const reportBounds = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    void window.app.browser.setBounds(id, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    });
  }, [id]);

  useEffect(() => {
    reportBounds();
    const observer = new ResizeObserver(reportBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener('resize', reportBounds);
    window.addEventListener('scroll', reportBounds, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
      window.removeEventListener('scroll', reportBounds, true);
    };
  }, [reportBounds]);

  const status = state?.status ?? 'idle';
  const proxy = state?.proxy;

  return (
    <article className="browser-tile">
      <div className="browser-tile__header">
        <strong>{state?.label ?? `Browser ${id}`}</strong>
        <span className={`status-pill status-pill--${status}`}>{status}</span>
        <span className="page-label">{state?.currentPage ? `Page ${state.currentPage}` : ''}</span>
      </div>
      <div className="browser-tile__viewport" ref={viewportRef} />
      <div className="browser-tile__footer">
        <span>{proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : 'Waiting for proxy'}</span>
        <span>{state?.message ?? ''}</span>
      </div>
    </article>
  );
}
