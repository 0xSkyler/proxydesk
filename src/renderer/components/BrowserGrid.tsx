import { useAppStore } from '../stores/appStore';
import { BrowserPanel } from './BrowserPanel';

export function BrowserGrid(): JSX.Element {
  const browsers = useAppStore((state) => state.browsers);
  const ids = Object.keys(browsers)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div className="browser-grid-lite">
      {ids.map((id) => (
        <BrowserPanel key={id} id={id} />
      ))}
    </div>
  );
}
