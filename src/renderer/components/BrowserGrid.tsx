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
  const columns = COLUMNS_FOR_LAYOUT[gridLayout] ?? 2;
  const ids = BROWSER_IDS.slice(0, browserCount);

  return (
    <div className="browser-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {ids.map((id) => (
        <BrowserPanel key={id} id={id} />
      ))}
    </div>
  );
}
