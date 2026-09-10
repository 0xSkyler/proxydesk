import { useEffect, useState } from 'react';
import type { DiagnosticsInfo } from '../../shared/types/ipc';
import { useAppStore } from '../stores/appStore';

export function DiagnosticsPanel(): JSX.Element {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const pushToast = useAppStore((s) => s.pushToast);

  useEffect(() => {
    let mounted = true;
    const load = () => window.app.system.getDiagnostics().then((d) => mounted && setInfo(d));
    void load();
    const interval = setInterval(load, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  async function copyDiagnostics() {
    if (!info) return;
    await window.app.system.copyToClipboard(JSON.stringify(info, null, 2));
    pushToast('Diagnostics copied to clipboard.', 'success');
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Diagnostics</h2>
        <button onClick={() => void copyDiagnostics()}>Copy Diagnostics</button>
      </div>
      {!info ? (
        <p className="muted">Loading…</p>
      ) : (
        <dl className="diagnostics-grid">
          <dt>Application version</dt>
          <dd>{info.appVersion}</dd>
          <dt>Electron version</dt>
          <dd>{info.electronVersion}</dd>
          <dt>Chromium version</dt>
          <dd>{info.chromeVersion}</dd>
          <dt>Node version</dt>
          <dd>{info.nodeVersion}</dd>
          <dt>OS version</dt>
          <dd>{info.osVersion}</dd>
          <dt>Platform / Arch</dt>
          <dd>
            {info.platform} / {info.arch}
          </dd>
          <dt>Browsers active</dt>
          <dd>{info.browserCount}</dd>
          <dt>Memory (RSS / Total)</dt>
          <dd>
            {info.memory.rssMb} MB / {info.memory.totalMb} MB
          </dd>
        </dl>
      )}
      <p className="muted">
        Logs are written to the application&rsquo;s logs folder (application.log, proxy.log, browser.log) and never
        contain passwords or authentication secrets.
      </p>
      <button onClick={() => void window.app.system.openLogsFolder()}>Open Logs Folder</button>
    </div>
  );
}
