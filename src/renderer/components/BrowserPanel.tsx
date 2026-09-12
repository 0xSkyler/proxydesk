import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppStore } from '../stores/appStore';
import { countryNameForCode } from '../../shared/constants/countries';

interface Props {
  id: number;
  /** Renders a slimmer header/toolbar/footer so a small square tile spends
   * most of its area on the actual page content instead of chrome. */
  compact?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  loading: 'Loading',
  connected: 'Online',
  'proxy-checking': 'Checking proxy',
  'proxy-failed': 'Proxy failed',
  'no-proxy': 'No proxy',
  crashed: 'Crashed'
};

const STATUS_DOT: Record<string, string> = {
  idle: 'dot-gray',
  loading: 'dot-blue',
  connected: 'dot-green',
  'proxy-checking': 'dot-yellow',
  'proxy-failed': 'dot-red',
  'no-proxy': 'dot-gray',
  crashed: 'dot-red'
};

export function BrowserPanel({ id, compact = false }: Props): JSX.Element {
  const browser = useAppStore((s) => s.browsers[id]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [addressValue, setAddressValue] = useState(browser?.url ?? '');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) setAddressValue(browser?.url ?? '');
  }, [browser?.url, menuOpen]);

  const reportBounds = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void window.app.browser.setBounds(id, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }, [id]);

  useEffect(() => {
    reportBounds();
    const observer = new ResizeObserver(reportBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener('resize', reportBounds);
    // The real Chromium content is a native BrowserView positioned by
    // absolute screen coordinates (see reportBounds above), which only ever
    // gets re-measured here — it does not move on its own when the page
    // scrolls. The old fixed-height grid never scrolled so this didn't
    // matter, but the square/mobile tile grid uses overflow-y as a safety
    // net once there are more tiles than fit on screen, so without this a
    // scroll would leave every BrowserView visually "stuck" in its old
    // position while the tile it belongs to moved out from under it.
    // Capture phase is required since 'scroll' does not bubble.
    window.addEventListener('scroll', reportBounds, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
      window.removeEventListener('scroll', reportBounds, true);
    };
  }, [reportBounds]);

  if (!browser) return <div className="browser-panel" />;

  const submitNavigate = (e: FormEvent) => {
    e.preventDefault();
    if (addressValue.trim()) void window.app.browser.navigate(id, addressValue.trim());
  };

  const menu = menuOpen && (
    <div className="browser-panel__menu-list" role="menu">
      <button onClick={() => { void window.app.browser.clearCookies(id); setMenuOpen(false); }}>
        Clear Cookies
      </button>
      <button onClick={() => { void window.app.browser.clearCache(id); setMenuOpen(false); }}>
        Clear Cache
      </button>
      <button onClick={() => { void window.app.browser.openDevTools(id); setMenuOpen(false); }}>
        Open DevTools
      </button>
      <button onClick={() => { void window.app.browser.restart(id); setMenuOpen(false); }}>
        Restart Browser
      </button>
    </div>
  );

  const viewport = (
    // This div's bounding rect is where the main process positions the
    // real BrowserView (the actual Chromium content) — see reportBounds
    // above and BrowserManager.setBounds in the main process.
    <div className="browser-panel__viewport" ref={viewportRef}>
      {browser.connectionStatus === 'crashed' && (
        <div className="browser-panel__overlay">
          <p>{browser.label} crashed.</p>
          <button onClick={() => void window.app.browser.restart(id)}>Restart</button>
        </div>
      )}
    </div>
  );

  if (compact) {
    // Small square tile: one slim header row (label, status, nav + menu)
    // and one slim footer row (proxy only), so the viewport — the actual
    // page content, which is the entire point of a tile you can glance
    // at — gets the large majority of the square instead of being
    // squeezed down to a sliver by full-size chrome.
    return (
      <section
        className="browser-panel browser-panel--compact"
        onMouseEnter={() => void window.app.browser.setActive(id)}
        aria-label={browser.label}
      >
        <header className="browser-panel__header">
          <span className={`status-dot ${STATUS_DOT[browser.connectionStatus] ?? 'dot-gray'}`} />
          <span className="browser-panel__title">{browser.label}</span>
          <div className="browser-panel__toolbar browser-panel__toolbar--compact">
            <button aria-label="Back" disabled={!browser.canGoBack} onClick={() => void window.app.browser.goBack(id)}>
              &#8592;
            </button>
            {browser.loading ? (
              <button aria-label="Stop loading" onClick={() => void window.app.browser.stop(id)}>
                &#10005;
              </button>
            ) : (
              <button aria-label="Reload" onClick={() => void window.app.browser.reload(id)}>
                &#8635;
              </button>
            )}
            <div className="browser-panel__menu">
              <button aria-label="Browser menu" onClick={() => setMenuOpen((v) => !v)}>
                &#8942;
              </button>
              {menu}
            </div>
          </div>
        </header>

        {viewport}

        <footer className="browser-panel__footer browser-panel__footer--compact">
          <span title={browser.proxy ? `${browser.proxy.host}:${browser.proxy.port}` : 'No proxy'}>
            {browser.proxy ? `${browser.proxy.host}:${browser.proxy.port}` : 'No proxy'}
          </span>
          <button aria-label="Change proxy" title="Change Proxy" onClick={() => void window.app.proxy.replaceFailed(id)}>
            &#8635;
          </button>
        </footer>
      </section>
    );
  }

  return (
    <section
      className="browser-panel"
      onMouseEnter={() => void window.app.browser.setActive(id)}
      aria-label={browser.label}
    >
      <header className="browser-panel__header">
        <span className="browser-panel__title">{browser.label}</span>
        <span className={`status-dot ${STATUS_DOT[browser.connectionStatus] ?? 'dot-gray'}`} />
        <span className="browser-panel__status-text">{STATUS_LABEL[browser.connectionStatus] ?? 'Unknown'}</span>
      </header>

      <div className="browser-panel__toolbar">
        <button aria-label="Back" disabled={!browser.canGoBack} onClick={() => void window.app.browser.goBack(id)}>
          &#8592;
        </button>
        <button
          aria-label="Forward"
          disabled={!browser.canGoForward}
          onClick={() => void window.app.browser.goForward(id)}
        >
          &#8594;
        </button>
        {browser.loading ? (
          <button aria-label="Stop loading" onClick={() => void window.app.browser.stop(id)}>
            &#10005;
          </button>
        ) : (
          <button aria-label="Reload" onClick={() => void window.app.browser.reload(id)}>
            &#8635;
          </button>
        )}
        <form className="browser-panel__address" onSubmit={submitNavigate}>
          <input
            aria-label="Address bar"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            placeholder="Enter a URL"
          />
        </form>
        <div className="browser-panel__menu">
          <button aria-label="Browser menu" onClick={() => setMenuOpen((v) => !v)}>
            &#8942;
          </button>
          {menu}
        </div>
      </div>

      {viewport}

      <footer className="browser-panel__footer">
        <span>
          Proxy: {browser.proxy ? `${browser.proxy.host}:${browser.proxy.port}` : 'None'}
        </span>
        <span>
          Country: {browser.proxy?.countryVerified
            ? countryNameForCode(browser.proxy.countryCode) ?? browser.proxy.countryCode
            : browser.proxy
            ? 'Unverified'
            : '—'}
        </span>
        <span>Latency: {browser.proxy?.latencyMs != null ? `${browser.proxy.latencyMs}ms` : '—'}</span>
        <button onClick={() => void window.app.proxy.replaceFailed(id)}>Change Proxy</button>
      </footer>
    </section>
  );
}
