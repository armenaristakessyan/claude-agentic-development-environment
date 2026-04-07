import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Plus, FolderOpen, Check, Trash2, Folder, ChevronUp, Search as SearchIcon, MapPin } from 'lucide-react';


interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  current: string;
  parent: string | null;
  name: string;
  entries: BrowseEntry[];
}

interface ScanPathsModalProps {
  scanPaths: string[];
  onSave: (paths: string[]) => void;
  onClose: () => void;
}

export default function ScanPathsModal({ scanPaths, onSave, onClose }: ScanPathsModalProps) {
  const [paths, setPaths] = useState<string[]>([...scanPaths]);
  const [manualInput, setManualInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch suggested paths on mount
  useEffect(() => {
    fetch('/api/suggest-paths')
      .then(r => r.json())
      .then((suggested: string[]) => setSuggestions(suggested))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (browsing) {
          setBrowsing(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, browsing]);

  const addPath = useCallback((path: string) => {
    const trimmed = path.trim();
    if (trimmed && !paths.includes(trimmed)) {
      setPaths(prev => [...prev, trimmed]);
    }
  }, [paths]);

  const removePath = useCallback((path: string) => {
    setPaths(prev => prev.filter(p => p !== path));
  }, []);

  const handleManualAdd = () => {
    if (manualInput.trim()) {
      addPath(manualInput);
      setManualInput('');
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleManualAdd();
    }
  };

  const handleSave = () => {
    onSave(paths.filter(p => p.trim()));
  };

  // Browse folder navigation
  const browseTo = useCallback(async (path: string) => {
    setBrowseLoading(true);
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data: BrowseResult = await res.json();
        setBrowseData(data);
      }
    } catch {
      // silently fail
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const openBrowser = useCallback(() => {
    setBrowsing(true);
    browseTo('~');
  }, [browseTo]);

  const selectBrowsedFolder = useCallback(() => {
    if (browseData) {
      addPath(browseData.current);
      setBrowsing(false);
    }
  }, [browseData, addPath]);

  const shortenPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

  const availableSuggestions = suggestions.filter(s => !paths.includes(s));

  // --- Browse view ---
  if (browsing) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        onClick={() => setBrowsing(false)}
      >
        <div
          className="mx-4 flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-border-default bg-modal shadow-2xl"
          style={{ height: '480px' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Browser header */}
          <div className="flex items-center gap-2 border-b border-border-default px-4 py-3">
            <FolderOpen className="h-4 w-4 text-muted" />
            <span className="flex-1 truncate text-[13px] text-tertiary">
              {browseData ? shortenPath(browseData.current) : '...'}
            </span>
            <button
              onClick={() => setBrowsing(false)}
              className="rounded-lg p-1.5 text-faint transition-colors hover:bg-elevated hover:text-tertiary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Go up */}
          {browseData?.parent && (
            <button
              onClick={() => browseTo(browseData.parent!)}
              className="flex items-center gap-2 border-b border-border-default/50 px-4 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-secondary"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              <span>..</span>
            </button>
          )}

          {/* Directory listing */}
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {browseLoading ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-[12px] text-faint">Loading...</span>
              </div>
            ) : browseData?.entries.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-[12px] text-faint">Empty directory</span>
              </div>
            ) : (
              browseData?.entries.map(entry => (
                <button
                  key={entry.path}
                  onClick={() => browseTo(entry.path)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="truncate text-[13px] text-tertiary">{entry.name}</span>
                </button>
              ))
            )}
          </div>

          {/* Browser footer */}
          <div className="flex items-center justify-between border-t border-border-default px-4 py-3">
            <span className="text-[11px] text-faint">
              {browseData ? `${browseData.entries.length} folders` : ''}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setBrowsing(false)}
                className="rounded-lg px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-secondary"
              >
                Cancel
              </button>
              <button
                onClick={selectBrowsedFolder}
                disabled={!browseData}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600/80 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-blue-500/80 disabled:opacity-30"
              >
                <Plus className="h-3 w-3" />
                Add this folder
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Main view ---
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-md overflow-hidden rounded-xl border border-border-default bg-modal shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-default px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
              <MapPin className="h-4 w-4 text-blue-400" />
            </div>
            <span className="text-[14px] font-medium text-primary">Scan Paths</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-faint transition-colors hover:bg-elevated hover:text-tertiary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {/* Current paths */}
          {paths.length > 0 && (
            <div className="mb-4 flex flex-col gap-1">
              {paths.map(path => (
                <div
                  key={path}
                  className="group flex items-center gap-2 rounded-lg bg-root px-3 py-2"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="flex-1 truncate text-[13px] text-secondary">{shortenPath(path)}</span>
                  <button
                    onClick={() => removePath(path)}
                    className="shrink-0 text-faint opacity-0 transition-all hover:text-red-400 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Suggestions */}
          {availableSuggestions.length > 0 && (
            <div className="mb-4">
              <span className="mb-2 block text-[11px] text-faint">Detected on this machine</span>
              <div className="flex flex-wrap gap-1.5">
                {availableSuggestions.map(path => (
                  <button
                    key={path}
                    onClick={() => addPath(path)}
                    className="flex items-center gap-1.5 rounded-full border border-border-input px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-border-focus hover:text-secondary"
                  >
                    <Plus className="h-3 w-3" />
                    {shortenPath(path)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Manual input + Browse button */}
          <div className="mb-4 flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a path or paste one..."
              className="flex-1 rounded-lg border border-border-input bg-root px-3 py-2 text-[13px] text-secondary placeholder-placeholder outline-none transition-colors focus:border-border-focus"
            />
            <button
              onClick={handleManualAdd}
              disabled={!manualInput.trim()}
              className="rounded-lg border border-border-input p-2 text-faint transition-colors hover:border-border-focus hover:text-secondary disabled:opacity-30"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Browse button */}
          <button
            onClick={openBrowser}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-input bg-root py-3 text-[13px] text-muted transition-colors hover:border-border-focus hover:text-secondary"
          >
            <SearchIcon className="h-3.5 w-3.5" />
            Browse folders
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border-default px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-[13px] text-muted transition-colors hover:text-secondary"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600/80 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-blue-500/80"
          >
            <Check className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
