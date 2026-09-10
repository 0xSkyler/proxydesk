import { useState } from 'react';
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
          One proxy per line. Supported formats: <code>http://host:port</code>,{' '}
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
