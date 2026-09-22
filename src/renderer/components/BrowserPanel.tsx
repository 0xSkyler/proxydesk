import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

interface Props {
  id: number;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  loading: 'Loading',
  connected: 'Ready',
  'proxy-checking': 'Proxy assigned',
  'proxy-failed': 'Proxy failed',
  'no-proxy': 'Waiting for proxy',
  crashed: 'Crashed'
};

export function BrowserPanel({ id }: Props): JSX.Element {
  const browser = useAppStore((state) => state.browsers[id]);
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

  if (!browser) return <section className="browser-card browser-card--empty" />;

  const proxyText = browser.proxy
    ? `${browser.proxy.protocol}://${browser.proxy.host}:${browser.proxy.port}`
    : 'No proxy';

  return (
    <section className="browser-card">
      <header className="browser-card__header">
        <strong>{browser.label}</strong>
        <span className={browser.connectionStatus === 'proxy-failed' ? 'status-bad' : 'muted'}>
          {STATUS_LABEL[browser.connectionStatus] ?? browser.connectionStatus}
        </span>
      </header>

      <div className="browser-card__meta">
        <span title={proxyText}>{proxyText}</span>
        <span>{browser.proxy?.latencyMs != null ? `${browser.proxy.latencyMs} ms` : '—'}</span>
        <span className={browser.keepAliveEnabled ? 'status-ok' : 'muted'}>
          {browser.keepAliveEnabled ? 'Keep Alive active' : 'Keep Alive idle'}
        </span>
        <button
          className="browser-keepalive-button"
          disabled={browser.keepAliveEnabled}
          onClick={() => void window.app.browser.setKeepAlive(id, true)}
        >
          Start Keep Alive
        </button>
        <button
          className="browser-keepalive-button"
          disabled={!browser.keepAliveEnabled}
          onClick={() => void window.app.browser.setKeepAlive(id, false)}
        >
          Stop
        </button>
      </div>

      <div className="browser-card__viewport" ref={viewportRef} />

      <footer className="browser-card__footer" title={browser.url}>
        {browser.url || 'Waiting for SEO Tracker…'}
      </footer>
    </section>
  );
}
