import { useAppStore } from '../stores/appStore';
import { BROWSER_IDS } from '../../shared/types/browser';
import { BrowserPanel } from './BrowserPanel';

const COLUMNS_FOR_LAYOUT: Record<string, number> = {
  '1x10': 1,
  '2x5': 2,
  '5x2': 5
};

export function BrowserGrid(): JSX.Element {
  const gridLayout = useAppStore((s) => s.settings.browser.gridLayout);
  const browserCount = useAppStore((s) => s.settings.browser.browserCount);
  const ids = BROWSER_IDS.slice(0, browserCount);

  // "square" renders every browser as a small, mobile-icon-like square tile
  // (auto-fill columns + aspect-ratio: 1/1 in CSS) instead of stretching
  // panels to fill the window — the old fixed-column layouts gave the
  // viewport almost no height once there were 2+ rows, which is why the
  // actual page content was invisible even though the browser was working.
  if (gridLayout === 'square') {
    return (
      <div className="browser-grid browser-grid--square">
        {ids.map((id) => (
          <BrowserPanel key={id} id={id} compact />
        ))}
      </div>
    );
  }

  const columns = COLUMNS_FOR_LAYOUT[gridLayout] ?? 2;

  return (
    <div className="browser-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {ids.map((id) => (
        <BrowserPanel key={id} id={id} />
      ))}
    </div>
  );
}
