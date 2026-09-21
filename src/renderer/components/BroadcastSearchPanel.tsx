import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { BROWSER_IDS } from '../../shared/types/browser';
import type { BroadcastSearchResult, BroadcastSearchStatus } from '../../shared/types/browser';
import type { SeoAutomationState } from '../../shared/types/automation';

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
  const [sourceFilePath, setSourceFilePath] = useState('');
  const [intervalSec, setIntervalSec] = useState(600);
  const [automation, setAutomation] = useState<SeoAutomationState | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.app.automation.getState().then((state) => {
      if (!mounted) return;
      setAutomation(state);
      if (state.sourceFilePath) setSourceFilePath(state.sourceFilePath);
      if (state.query) setQuery(state.query);
      if (state.targetWebsite) setTargetWebsite(state.targetWebsite);
      if (state.intervalSec) setIntervalSec(state.intervalSec);
      if (state.browserIds.length > 0) setSelectedIds(new Set(state.browserIds));
    });

    const offState = window.app.automation.onStateChanged((state) => {
      setAutomation(state);
    });
    const offResult = window.app.automation.onSeoResult(({ result }) => {
      setResults((prev) => ({ ...prev, [result.browserId]: result }));
    });

    return () => {
      mounted = false;
      offState();
      offResult();
    };
  }, []);

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

  async function chooseAutomationFile() {
    const filePath = await window.app.system.pickProxyFile();
    if (filePath) setSourceFilePath(filePath);
  }

  async function startAutomation() {
    const browserIds = ids.filter((id) => selectedIds.has(id));
    try {
      const state = await window.app.automation.start({
        sourceFilePath,
        query,
        targetWebsite,
        intervalSec,
        browserIds
      });
      setAutomation(state);
      pushToast(
        `Autonomous SEO started — proxy file will be re-read every ${state.intervalSec} second(s).`,
        'success'
      );
    } catch (err) {
      pushToast(`Could not start autonomous SEO: ${(err as Error).message}`, 'error');
    }
  }

  async function stopAutomation() {
    const state = await window.app.automation.stop();
    setAutomation(state);
    pushToast('Autonomous SEO rotation stopped.', 'info');
  }

  async function runAutomationNow() {
    try {
      await window.app.automation.runNow();
      pushToast('Automation cycle requested.', 'info');
    } catch (err) {
      pushToast(`Could not run automation cycle: ${(err as Error).message}`, 'error');
    }
  }

  const automationRunning = automation?.running ?? false;
  const nextCycleText = automation?.nextCycleAt ? new Date(automation.nextCycleAt).toLocaleTimeString() : '—';

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>SEO Tracker</h2>
      </div>

      <p className="muted">
        A manual run searches Google once. Autonomous mode re-reads your selected proxy file every cycle, validates
        its proxies concurrently, assigns each working proxy immediately as soon as it is confirmed, runs the saved
        keyword + target search in that browser, clicks the matching Google result, and then switches that browser
        into enhanced Keep Alive.
      </p>

      <div className="provider-form" style={{ maxWidth: 680 }}>
        <label>
          Google keyword / search query
          <input
            type="text"
            value={query}
            disabled={automationRunning}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. garment inventory safety stock Bangladesh"
          />
        </label>
        <label>
          Target website or domain
          <input
            type="text"
            value={targetWebsite}
            disabled={automationRunning}
            onChange={(e) => setTargetWebsite(e.target.value)}
            placeholder="e.g. appareldiary.com"
          />
        </label>
      </div>

      <div className="panel__section">
        <h3>Autonomous proxy + SEO rotation</h3>
        <p className="muted">
          The file path, keyword and target are kept for the current app session only. Each cycle reads the file
          again, so you can update the file on disk and ProxyDesk will validate the latest contents on the next
          cycle. Default cadence is 600 seconds (10 minutes).
        </p>

        <div className="provider-form" style={{ maxWidth: 760 }}>
          <label>
            Live proxy source file
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                readOnly
                value={sourceFilePath}
                placeholder="Select a proxy.txt / .csv file from this PC"
                style={{ flex: 1 }}
              />
              <button type="button" disabled={automationRunning} onClick={() => void chooseAutomationFile()}>
                Select File
              </button>
            </div>
          </label>
          <label>
            Rotation / cycle interval (seconds)
            <input
              type="number"
              min={5}
              max={86400}
              disabled={automationRunning}
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="panel__actions">
          <button
            className="btn-primary"
            disabled={automationRunning}
            onClick={() => void startAutomation()}
          >
            Start Autonomous SEO
          </button>
          <button disabled={!automationRunning} onClick={() => void runAutomationNow()}>
            Run Cycle Now
          </button>
          <button disabled={!automationRunning} onClick={() => void stopAutomation()}>
            Stop Autonomous SEO
          </button>
        </div>

        <div className="muted" style={{ marginTop: 10 }}>
          Status: {automationRunning ? (automation?.cycleInProgress ? 'RUNNING CYCLE' : 'WAITING') : 'STOPPED'}
          {' · '}Cycle: {automation?.cycleNumber ?? 0}
          {' · '}Validation: {automation?.checkedProxies ?? 0}/{automation?.totalProxies ?? 0}
          {' · '}Live: {automation?.liveProxies ?? 0}
          {' · '}Assigned: {automation?.assignedBrowsers ?? 0}/{automation?.browserIds.length ?? 0}
          {' · '}Next: {nextCycleText}
        </div>
        {automation?.lastError && <p className="status-bad">Last automation error: {automation.lastError}</p>}
        <p className="muted">
          Google challenge/consent pages are reported as blocked for that cycle. Autonomous mode does not immediately
          switch proxies in response to a challenge; it waits for the normal scheduled rotation.
        </p>
      </div>

      <div className="panel__section">
        <h3>Run on browsers</h3>
        <div className="filters">
          {ids.map((id) => (
            <label key={id} className="checkbox-label">
              <input
                type="checkbox"
                disabled={automationRunning}
                checked={selectedIds.has(id)}
                onChange={() => toggleId(id)}
              />
              {browsers[id]?.label ?? `Browser ${id}`}
            </label>
          ))}
        </div>
        <div className="panel__actions">
          <button
            onClick={() => setSelectedIds(new Set(ids))}
            disabled={running || automationRunning}
          >
            Select All
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            disabled={running || automationRunning}
          >
            Select None
          </button>
          <button
            className="btn-primary"
            onClick={() => void run()}
            disabled={running || automationRunning}
          >
            {running ? 'Searching Google…' : 'Run SEO Search Once'}
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
