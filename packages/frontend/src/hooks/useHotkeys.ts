import { useEffect, useRef } from 'react';

interface HotkeyBinding {
  key: string;         // e.g. 'Meta+1', 'Meta+Enter', 'Tab'
  handler: () => void;
  enabled?: boolean;   // default true
}

/**
 * Lightweight hotkey hook. Supports Meta (Cmd), Shift, Alt modifiers.
 * Format: "Meta+Shift+k", "Tab", "Meta+Enter"
 */
export function useHotkeys(bindings: HotkeyBinding[]): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in input/textarea (unless it's a Meta combo)
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      for (const binding of bindingsRef.current) {
        if (binding.enabled === false) continue;

        const parts = binding.key.split('+');
        const key = parts[parts.length - 1];
        const needsMeta = parts.includes('Meta');
        const needsShift = parts.includes('Shift');
        const needsAlt = parts.includes('Alt');

        // For non-modifier keys in input fields, skip unless Meta is required
        if (isInput && !needsMeta) continue;

        const keyMatch =
          e.key === key ||
          e.key.toLowerCase() === key.toLowerCase() ||
          e.code === `Digit${key}` ||
          e.code === `Key${key.toUpperCase()}`;

        if (
          keyMatch &&
          e.metaKey === needsMeta &&
          e.shiftKey === needsShift &&
          e.altKey === needsAlt
        ) {
          e.preventDefault();
          e.stopPropagation();
          binding.handler();
          return;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
