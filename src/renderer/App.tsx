import { useAppData } from './hooks/useAppData';
import { SeoTrackerPanel } from './components/SeoTrackerPanel';
import { BrowserGrid } from './components/BrowserGrid';
import { Toasts } from './components/Toasts';

export default function App(): JSX.Element {
  useAppData();

  return (
    <div className="lite-shell">
      <SeoTrackerPanel />
      <main className="lite-browser-area">
        <BrowserGrid />
      </main>
      <Toasts />
    </div>
  );
}
