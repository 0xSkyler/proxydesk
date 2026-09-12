import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

export function Toasts(): JSX.Element {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  // Each toast gets exactly one 6s auto-dismiss timer, scheduled the moment
  // it first appears. Previously this effect depended on the whole `toasts`
  // array, so every new toast reran it, clearing every pending timer and
  // restarting a fresh 6s countdown for ALL toasts already on screen —
  // meaning one toast every few seconds (e.g. repeated clicks) kept
  // resetting the others' timers forever and they piled up on screen
  // instead of clearing individually. Tracking already-scheduled ids in a
  // ref means a later toast no longer touches earlier toasts' timers.
  const scheduledIds = useRef(new Set<string>());

  useEffect(() => {
    const currentIds = new Set(toasts.map((t) => t.id));
    for (const id of scheduledIds.current) {
      if (!currentIds.has(id)) scheduledIds.current.delete(id);
    }

    const newTimers: ReturnType<typeof setTimeout>[] = [];
    for (const t of toasts) {
      if (scheduledIds.current.has(t.id)) continue;
      scheduledIds.current.add(t.id);
      newTimers.push(
        setTimeout(() => {
          scheduledIds.current.delete(t.id);
          dismissToast(t.id);
        }, 6000)
      );
    }
    return () => newTimers.forEach(clearTimeout);
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
