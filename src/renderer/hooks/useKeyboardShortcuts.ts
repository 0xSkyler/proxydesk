import { useEffect } from 'react';

export interface ShortcutHandlers {
  onReloadSelected: () => void;
  onReloadAll: () => void;
  onOpenProxyManager: () => void;
  onReloadProxies: () => void;
  onOpenSettings: () => void;
}

/**
 * Global shortcuts. Modifier-gated (Ctrl/Cmd) so they never fight with
 * normal typing inside the address bar or proxy manager search field.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const tag = (e.target as HTMLElement | null)?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA';

      if (e.key === ',' ) {
        e.preventDefault();
        handlers.onOpenSettings();
        return;
      }
      if (isTyping) return;

      if (e.key.toLowerCase() === 'r' && e.shiftKey) {
        e.preventDefault();
        handlers.onReloadAll();
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handlers.onReloadSelected();
      } else if (e.key.toLowerCase() === 'p' && e.shiftKey) {
        e.preventDefault();
        handlers.onReloadProxies();
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handlers.onOpenProxyManager();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
