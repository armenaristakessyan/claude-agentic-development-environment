import { Moon, Sun, X } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

type Theme = 'dark' | 'light';
type Zoom = 100 | 110 | 125 | 150;

const ZOOM_OPTIONS: Zoom[] = [100, 110, 125, 150];

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { theme, zoom, setTheme, setZoom } = useTheme();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-xl border border-border-default bg-modal shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-default px-5 py-3.5">
          <h2 className="text-[14px] font-medium text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted transition-colors hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {/* Theme */}
          <div>
            <label className="mb-2 block text-[12px] font-medium uppercase tracking-wider text-muted">
              Theme
            </label>
            <div className="grid grid-cols-2 gap-2">
              <ThemeCard
                label="Dark"
                icon={<Moon className="h-4 w-4" />}
                active={theme === 'dark'}
                onClick={() => setTheme('dark')}
                swatches={['#0d0d0d', '#161616', '#1e1e1e', '#2a2a2a']}
              />
              <ThemeCard
                label="Light"
                icon={<Sun className="h-4 w-4" />}
                active={theme === 'light'}
                onClick={() => setTheme('light')}
                swatches={['#f5f5f5', '#ffffff', '#f0f0f0', '#e5e5e5']}
              />
            </div>
          </div>

          {/* Zoom */}
          <div>
            <label className="mb-2 block text-[12px] font-medium uppercase tracking-wider text-muted">
              Zoom
            </label>
            <div className="flex gap-2">
              {ZOOM_OPTIONS.map(z => (
                <button
                  key={z}
                  onClick={() => setZoom(z)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
                    zoom === z
                      ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                      : 'border-border-default bg-elevated text-tertiary hover:text-secondary'
                  }`}
                >
                  {z}%
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer — version */}
        <div className="flex items-center justify-between border-t border-border-default px-5 py-2.5">
          <span className="text-[11px] text-muted">ADE</span>
          <span className="font-mono text-[11px] text-muted">v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  label,
  icon,
  active,
  onClick,
  swatches,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  swatches: string[];
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors ${
        active
          ? 'border-blue-500/50 bg-blue-500/10'
          : 'border-border-default bg-elevated hover:border-border-input'
      }`}
    >
      <div className={`${active ? 'text-blue-400' : 'text-muted'}`}>{icon}</div>
      <span className={`text-[12px] font-medium ${active ? 'text-blue-400' : 'text-tertiary'}`}>
        {label}
      </span>
      <div className="flex gap-1">
        {swatches.map((color, i) => (
          <div
            key={i}
            className="h-3 w-3 rounded-sm border border-border-default"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </button>
  );
}
