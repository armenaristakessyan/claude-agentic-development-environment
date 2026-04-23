import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader, X, Hash, FileText, Box, Braces, Component } from 'lucide-react';
import { FileIcon } from './FileViewerPanel';

interface FileResult { filePath: string }
interface SymbolResult { filePath: string; line: number; name: string; kind: string }

interface QuickOpenModalProps {
  projectPath: string;
  onSelect: (filePath: string, line?: number) => void;
  onClose: () => void;
}

// Mode is toggled via keystroke, not kept in the text buffer:
//   typing `#` on an empty input   → switch to symbols
//   Backspace on an empty input    → switch back to files
// The `#` is never inserted into the visible input, mirroring the user's
// intent that the prefix controls mode but doesn't clutter the field.
type Mode = 'files' | 'symbols';

function SymbolKindIcon({ kind }: { kind: string }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (kind) {
    case 'class':
    case 'struct':
    case 'trait':
    case 'impl':
      return <Box className={`${cls} text-orange-400`} />;
    case 'interface':
    case 'type':
      return <Component className={`${cls} text-blue-400`} />;
    case 'enum':
    case 'namespace':
    case 'module':
      return <Braces className={`${cls} text-purple-400`} />;
    default:
      return <FileText className={`${cls} text-emerald-400`} />;
  }
}

export default function QuickOpenModal({ projectPath, onSelect, onClose }: QuickOpenModalProps) {
  const [term, setTerm] = useState('');
  const [mode, setMode] = useState<Mode>('files');
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [symbolResults, setSymbolResults] = useState<SymbolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Fetch with cancellation on each keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setLoading(true);

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(
          `/api/projects/quick-open?path=${encodeURIComponent(projectPath)}&mode=${mode}&q=${encodeURIComponent(term)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!res.ok) return;
        const data = await res.json() as { results: (FileResult | SymbolResult)[] };
        if (mode === 'files') {
          setFileResults(data.results as FileResult[]);
          setSymbolResults([]);
        } else {
          setSymbolResults(data.results as SymbolResult[]);
          setFileResults([]);
        }
        setSelectedIdx(0);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    }, 80);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [projectPath, mode, term]);

  const activeResults: (FileResult | SymbolResult)[] =
    mode === 'files' ? fileResults : symbolResults;

  // Keep highlighted item visible when navigating with keys.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback((r: FileResult | SymbolResult) => {
    if ('line' in r) onSelect(r.filePath, r.line);
    else onSelect(r.filePath);
    onClose();
  }, [onSelect, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // `#` on an empty input toggles into symbol mode without inserting the
    // character. Works from any mode so repeated presses are idempotent.
    if (e.key === '#' && term === '') {
      e.preventDefault();
      setMode('symbols');
      return;
    }
    // Backspace on an empty input in symbol mode returns to file search.
    if (e.key === 'Backspace' && term === '' && mode === 'symbols') {
      e.preventDefault();
      setMode('files');
      return;
    }
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, activeResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && activeResults.length > 0) {
      e.preventDefault();
      handleSelect(activeResults[selectedIdx]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="mx-4 flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-default bg-modal shadow-2xl"
        style={{ maxHeight: '60vh' }}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Input */}
        <div className="flex items-center gap-3 border-b border-border-default px-4 py-3">
          {mode === 'symbols' ? <Hash className="h-4 w-4 shrink-0 text-violet-300" /> : <Search className="h-4 w-4 shrink-0 text-faint" />}
          <input
            ref={inputRef}
            type="text"
            placeholder={mode === 'symbols' ? 'Search symbols...' : 'Go to file...  (type # to search symbols)'}
            value={term}
            onChange={e => setTerm(e.target.value)}
            className="w-full bg-transparent text-[14px] text-secondary placeholder-placeholder outline-none"
          />
          {loading && <Loader className="h-3.5 w-3.5 shrink-0 animate-spin text-faint" />}
          <button onClick={onClose} className="shrink-0 rounded p-0.5 text-faint hover:text-secondary">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {activeResults.length === 0 && !loading ? (
            <div className="px-4 py-8 text-center text-[12px] text-faint">
              {mode === 'symbols'
                ? (term ? 'No symbols match' : 'Type a symbol name')
                : 'No files match'}
            </div>
          ) : mode === 'files' ? (
            (fileResults).map((r, idx) => {
              const fileName = r.filePath.split('/').pop() ?? r.filePath;
              const dir = r.filePath.slice(0, r.filePath.length - fileName.length).replace(/\/$/, '');
              const isSelected = idx === selectedIdx;
              return (
                <button
                  key={r.filePath}
                  onClick={() => handleSelect(r)}
                  className={`flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-blue-500/15' : 'hover:bg-hover'
                  }`}
                >
                  <FileIcon fileName={fileName} />
                  <span className="truncate text-[12px] text-secondary">{fileName}</span>
                  {dir && <span className="truncate text-[11px] text-faint">{dir}</span>}
                </button>
              );
            })
          ) : (
            symbolResults.map((r, idx) => {
              const fileName = r.filePath.split('/').pop() ?? r.filePath;
              const isSelected = idx === selectedIdx;
              return (
                <button
                  key={`${r.filePath}:${r.line}:${r.name}`}
                  onClick={() => handleSelect(r)}
                  className={`flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-blue-500/15' : 'hover:bg-hover'
                  }`}
                >
                  <SymbolKindIcon kind={r.kind} />
                  <span className="truncate text-[12px] text-secondary">{r.name}</span>
                  <span className="shrink-0 rounded bg-elevated px-1.5 text-[10px] uppercase tracking-wide text-faint">{r.kind}</span>
                  <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2">
                    <FileIcon fileName={fileName} />
                    <span className="truncate text-[11px] text-faint">{r.filePath}:{r.line}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-border-default px-4 py-1.5">
          <span className="text-[10px] text-faint">
            {activeResults.length > 0 ? `${activeResults.length} ${mode === 'symbols' ? 'symbol' : 'file'}${activeResults.length !== 1 ? 's' : ''}` : ''}
          </span>
          <div className="flex-1" />
          <span className="text-[10px] text-faint">
            <kbd className="rounded border border-border-default bg-elevated px-1 py-0.5 text-[9px]">#</kbd> symbols
            <span className="mx-1.5">|</span>
            <kbd className="rounded border border-border-default bg-elevated px-1 py-0.5 text-[9px]">↑↓</kbd> nav
            <span className="mx-1.5">|</span>
            <kbd className="rounded border border-border-default bg-elevated px-1 py-0.5 text-[9px]">Enter</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}
