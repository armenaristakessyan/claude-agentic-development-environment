import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useConfig } from '../hooks/useConfig';

type Theme = 'dark' | 'light';
type Zoom = 100 | 110 | 125 | 150;

interface ThemeContextValue {
  theme: Theme;
  zoom: Zoom;
  setTheme: (theme: Theme) => void;
  setZoom: (zoom: Zoom) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Apply theme to DOM immediately (used by provider and flash-prevention script) */
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('ade-theme', theme);

  // Update PWA theme-color meta tag
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#0d0d0d' : '#f5f5f5');
  }
}

function applyZoom(zoom: Zoom) {
  document.documentElement.style.setProperty('zoom', String(zoom / 100));
  localStorage.setItem('ade-zoom', String(zoom));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { config, updateConfig } = useConfig();

  const [theme, setThemeState] = useState<Theme>(() => {
    // Read from localStorage for instant application (before config loads)
    const stored = localStorage.getItem('ade-theme');
    return (stored === 'light' ? 'light' : 'dark');
  });

  const [zoom, setZoomState] = useState<Zoom>(() => {
    const stored = localStorage.getItem('ade-zoom');
    const parsed = Number(stored);
    return ([100, 110, 125, 150].includes(parsed) ? parsed : 100) as Zoom;
  });

  // Sync from config when it loads (config is authoritative)
  useEffect(() => {
    if (!config) return;
    if (config.theme && config.theme !== theme) {
      setThemeState(config.theme);
      applyTheme(config.theme);
    }
    if (config.zoom && config.zoom !== zoom) {
      setZoomState(config.zoom);
      applyZoom(config.zoom);
    }
  }, [config?.theme, config?.zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply theme/zoom to DOM on state change
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { applyZoom(zoom); }, [zoom]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    updateConfig({ theme: t }).catch(() => {});
  }, [updateConfig]);

  const setZoom = useCallback((z: Zoom) => {
    setZoomState(z);
    applyZoom(z);
    updateConfig({ zoom: z }).catch(() => {});
  }, [updateConfig]);

  return (
    <ThemeContext.Provider value={{ theme, zoom, setTheme, setZoom }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
