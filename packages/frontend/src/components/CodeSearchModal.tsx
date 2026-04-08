import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader, X } from 'lucide-react';
import { FileIcon } from './FileViewerPanel';

interface SearchResult {
  filePath: string;
  line: number;
  text: string;
}

interface CodeSearchModalProps {
  projectPath: string;
  onSelect: (filePath: string, line: number) => void;
  onClose: () => void;
}

export default function CodeSearchModal({ projectPath, onSelect, onClose }: CodeSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Auto-focus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSelectedIdx(0);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/projects/search?path=${encodeURIComponent(projectPath)}&q=${encodeURIComponent(query.trim())}`);
        if (res.ok) {
          const data = await res.json() as { results: SearchResult[] };
          setResults(data.results);
          setSelectedIdx(0);
        }
      } catch { /* skip */ }
      setLoading(false);
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, projectPath]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback((result: SearchResult) => {
    onSelect(result.filePath, result.line);
    onClose();
  }, [onSelect, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      handleSelect(results[selectedIdx]);
    }
  };

  // Highlight matching text
  const highlightMatch = (text: string) => {
    if (!query.trim()) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + query.length);
    const after = text.slice(idx + query.length);
    return (
      <>
        {before}
        <span className="rounded bg-yellow-400/20 text-yellow-200">{match}</span>
        {after}
      </>
    );
  };

  // Group results by file
  const grouped = results.reduce<{ filePath: string; matches: SearchResult[] }[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && last.filePath === r.filePath) {
      last.matches.push(r);
    } else {
      acc.push({ filePath: r.filePath, matches: [r] });
    }
    return acc;
  }, []);

  // Flat index mapping for keyboard nav
  let flatIdx = 0;

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
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border-default px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search code in project..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full bg-transparent text-[14px] text-secondary placeholder-placeholder outline-none"
          />
          {loading && <Loader className="h-3.5 w-3.5 shrink-0 animate-spin text-faint" />}
          <button onClick={onClose} className="shrink-0 rounded p-0.5 text-faint hover:text-secondary">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {!query.trim() ? (
            <div className="px-4 py-8 text-center text-[12px] text-faint">
              Type to search across all project files
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="px-4 py-8 text-center text-[12px] text-faint">
              No results found
            </div>
          ) : (
            grouped.map(group => {
              const fileName = group.filePath.split('/').pop() ?? group.filePath;
              return (
                <div key={group.filePath}>
                  {/* File header */}
                  <div className="sticky top-0 flex items-center gap-1.5 bg-elevated/80 px-4 py-1 backdrop-blur-sm">
                    <FileIcon fileName={fileName} />
                    <span className="truncate text-[11px] font-medium text-tertiary">{group.filePath}</span>
                    <span className="text-[10px] text-faint">{group.matches.length}</span>
                  </div>
                  {/* Matches */}
                  {group.matches.map(match => {
                    const idx = flatIdx++;
                    const isSelected = idx === selectedIdx;
                    return (
                      <button
                        key={`${match.filePath}:${match.line}`}
                        onClick={() => handleSelect(match)}
                        className={`flex w-full items-center gap-3 px-4 py-1.5 text-left transition-colors ${
                          isSelected ? 'bg-blue-500/15' : 'hover:bg-hover'
                        }`}
                      >
                        <span className="w-8 shrink-0 text-right text-[10px] font-mono text-faint">
                          {match.line}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                          {highlightMatch(match.text)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        {results.length > 0 && (
          <div className="flex items-center gap-3 border-t border-border-default px-4 py-1.5">
            <span className="text-[10px] text-faint">
              {results.length} result{results.length !== 1 ? 's' : ''}
            </span>
            <div className="flex-1" />
            <span className="text-[10px] text-faint">
              <kbd className="rounded border border-border-default bg-elevated px-1 py-0.5 text-[9px]">Enter</kbd> to open
              <span className="mx-1.5">|</span>
              <kbd className="rounded border border-border-default bg-elevated px-1 py-0.5 text-[9px]">Esc</kbd> to close
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
