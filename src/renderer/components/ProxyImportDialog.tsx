import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ProxyImportResult } from '../../shared/types/proxy';

interface Props {
  onClose: () => void;
}

export function ProxyImportDialog({ onClose }: Props): JSX.Element {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ProxyImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pushToast = useAppStore((s) => s.pushToast);
  const setProxies = useAppStore((s) => s.setProxies);
  const openModal = useAppStore((s) => s.openModal);
  const closeModal = useAppStore((s) => s.closeModal);

  // This dialog can be open while the Browsers panel is still showing (the
  // toolbar's Import Proxies button doesn't switch panels) — but the real
  // BrowserViews behind each grid tile are native, OS-level content that
  // always paints on top of ordinary DOM elements regardless of CSS
  // z-index, including this modal's backdrop. Without this, the dialog
  // would silently render underneath the live browser tiles instead of
  // over them. Registering while mounted (and unregistering on close) is
  // what lets App.tsx push the grid off-screen for exactly as long as this
  // dialog is up, the same way it already does when switching to another
  // panel entirely (see grid-wrapper--offscreen).
  useEffect(() => {
    openModal();
    return () => closeModal();
    // open/close are stable zustand actions; re-running this on their
    // identity would defeat the mount/unmount-only pairing this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doImport(source: string) {
    setBusy(true);
    try {
      const res = await window.app.proxy.importText(source);
      setResult(res);
      const proxies = await window.app.proxy.getAll();
      setProxies(proxies);
      pushToast(`Imported ${res.valid} valid, ${res.invalid} invalid proxies.`, res.invalid > 0 ? 'info' : 'success');
    } catch (err) {
      pushToast(`Import failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function pickFile() {
    const filePath = await window.app.system.pickProxyFile();
    if (!filePath) return;
    setBusy(true);
    try {
      const res = await window.app.proxy.importFile(filePath);
      setResult(res);
      const proxies = await window.app.proxy.getAll();
      setProxies(proxies);
      pushToast(`Imported ${res.valid} valid, ${res.invalid} invalid proxies from file.`, 'success');
    } catch (err) {
      pushToast(`File import failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="modal modal--wide">
        <h2 id="import-title">Import Proxies</h2>
        <p className="muted">
          One proxy per line. Importing replaces the current session proxy pool; nothing is restored after restart.
          Supported formats: <code>http://host:port</code>,{' '}
          <code>http://user:pass@host:port</code>, <code>socks5://host:port</code>, <code>host:port</code>,{' '}
          <code>host:port:username:password</code>.
        </p>
        <textarea
          rows={8}
          placeholder={'http://1.2.3.4:8080\nsocks5://9.10.11.12:1080\n127.0.0.1:8080:user:pass'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="modal__actions">
          <button onClick={pickFile} disabled={busy}>
            Import .txt File
          </button>
          <button className="btn-primary" disabled={busy || !text.trim()} onClick={() => void doImport(text)}>
            Import Text
          </button>
          <button onClick={onClose}>Close</button>
        </div>

        {result && (
          <div className="import-summary">
            <p>
              Imported: {result.imported} &nbsp; Valid: {result.valid} &nbsp; Invalid: {result.invalid}
            </p>
            {result.invalidLines.length > 0 && (
              <details>
                <summary>Show {result.invalidLines.length} invalid line(s)</summary>
                <pre>{result.invalidLines.join('\n')}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
