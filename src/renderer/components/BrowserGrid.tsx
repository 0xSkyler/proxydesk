import { useAppStore } from '../stores/appStore';
import { BROWSER_IDS } from '../../shared/types/browser';
import { BrowserPanel } from './BrowserPanel';

export function BrowserGrid(): JSX.Element {
  const browser = useAppStore((s) => s.settings.browser);
  const ids = BROWSER_IDS.slice(0, browser.browserCount);

  // "Square tiles" renders every browser as a small, mobile-icon-like
  // square (auto-fill columns sized by tileMinHeight + aspect-ratio: 1/1
  // in CSS) instead of a fixed number of columns — good when browserCount
  // is large and you'd rather see many small tiles than scroll through a
  // few big ones.
  if (browser.gridSquareTiles) {
    return (
      <div
        className="browser-grid browser-grid--square"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${browser.tileMinHeight}px, 1fr))` }}
      >
        {ids.map((id) => (
          <BrowserPanel key={id} id={id} compact />
        ))}
      </div>
    );
  }

  // Otherwise: an exact `gridColumns`-wide grid (rows follow automatically
  // from browserCount/gridColumns) with each row at least `tileMinHeight`
  // tall — e.g. browserCount 6 + gridColumns 2 is a 2x3 grid, browserCount
  // 20 + gridColumns 2 is 2x10. The grid scrolls if there isn't room for
  // every row at once rather than compressing rows into invisibility.
  return (
    <div
      className="browser-grid"
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, browser.gridColumns)}, 1fr)`,
        gridAutoRows: `minmax(${browser.tileMinHeight}px, auto)`
      }}
    >
      {ids.map((id) => (
        <BrowserPanel key={id} id={id} />
      ))}
    </div>
  );
}
