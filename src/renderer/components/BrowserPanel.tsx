import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppStore } from '../stores/appStore';
import { countryNameForCode } from '../../shared/constants/countries';

interface Props {
  id: number;
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

export function BrowserPanel({ id }: Props): JSX.Element {
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
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
    };
  }, [reportBounds]);

  if (!browser) return <div className="browser-panel" />;

  const submitNavigate = (e: FormEvent) => {
    e.preventDefault();
    if (addressValue.trim()) void window.app.browser.navigate(id, addressValue.trim());
  };

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
          {menuOpen && (
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
          )}
        </div>
      </div>

      {/* This div's bounding rect is where the main process positions the
          real BrowserView (the actual Chromium content) — see reportBounds
          above and BrowserManager.setBounds in the main process. */}
      <div className="browser-panel__viewport" ref={viewportRef}>
        {browser.connectionStatus === 'crashed' && (
          <div className="browser-panel__overlay">
            <p>{browser.label} crashed.</p>
            <button onClick={() => void window.app.browser.restart(id)}>Restart</button>
          </div>
        )}
      </div>

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
