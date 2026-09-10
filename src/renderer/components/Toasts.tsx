import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

export function Toasts(): JSX.Element {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dismissToast(t.id), 6000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span>{t.message}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
