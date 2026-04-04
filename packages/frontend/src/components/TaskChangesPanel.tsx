import { X, ChevronDown, ChevronRight, Loader, FileDiff, RefreshCw, Undo2 } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import type { Instance } from '../types';
import type { GitChange } from './Sidebar';

interface TaskChangesPanelProps {
  instanceId: string;
  instances: Instance[];
  width: number;
  onClose: () => void;
}

export default function TaskChangesPanel({ instanceId, instances, width, onClose }: TaskChangesPanelProps) {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [revertConfirm, setRevertConfirm] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);

  const instance = instances.find(i => i.id === instanceId);

  const fetchChanges = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/instances/${instanceId}/context/changes`);
      if (res.ok) {
        const data = await res.json() as { files: GitChange[] };
        setChanges(data.files);
      }
    } catch { /* skip */ }
    setLoading(false);
  }, [instanceId]);

  useEffect(() => {
    fetchChanges();
    const interval = setInterval(fetchChanges, 10000);
    return () => clearInterval(interval);
  }, [fetchChanges]);

  const toggleExpanded = async (filePath: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) { next.delete(filePath); } else { next.add(filePath); }
      return next;
    });
    if (expandedFiles.has(filePath)) return; // was open, now closing — no fetch needed
    if (!diffs[filePath]) {
      setDiffLoading(filePath);
      try {
        const res = await fetch(`/api/instances/${instanceId}/context/diff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath }),
        });
        if (res.ok) {
          const data = await res.json() as { diff: string };
          setDiffs(prev => ({ ...prev, [filePath]: data.diff }));
        } else {
          setDiffs(prev => ({ ...prev, [filePath]: '(no diff available)' }));
        }
      } catch {
        setDiffs(prev => ({ ...prev, [filePath]: '(failed to load diff)' }));
      }
      setDiffLoading(null);
    }
  };

  const revertFile = async (filePath: string) => {
    setReverting(filePath);
    try {
      const res = await fetch(`/api/instances/${instanceId}/context/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      if (res.ok) {
        // Remove from local state immediately
        setChanges(prev => prev.filter(f => f.path !== filePath));
        setDiffs(prev => { const next = { ...prev }; delete next[filePath]; return next; });
        setExpandedFiles(prev => { const next = new Set(prev); next.delete(filePath); return next; });
      }
    } catch { /* skip */ }
    setReverting(null);
    setRevertConfirm(null);
  };

  const totalAdded = changes.filter(f => f.status === 'A' || f.status === '??').length;
  const totalModified = changes.filter(f => f.status === 'M').length;
  const totalDeleted = changes.filter(f => f.status === 'D').length;

  const statusIcon = (s: string) => {
    if (s === 'M') return 'M';
    if (s === 'A') return 'A';
    if (s === '??') return 'U';
    if (s === 'D') return 'D';
    if (s === 'R') return 'R';
    return s;
  };

  const statusDotColor = (s: string) => {
    if (s === 'M') return 'bg-amber-400';
    if (s === 'A' || s === '??') return 'bg-green-400';
    if (s === 'D') return 'bg-red-400';
    if (s === 'R') return 'bg-blue-400';
    return 'bg-neutral-500';
  };

  const statusTextColor = (s: string) => {
    if (s === 'M') return 'text-amber-400';
    if (s === 'A' || s === '??') return 'text-green-400';
    if (s === 'D') return 'text-red-400';
    if (s === 'R') return 'text-blue-400';
    return 'text-neutral-500';
  };

  return (
    <div className="flex h-full shrink-0 flex-col overflow-hidden rounded-xl bg-[#161616]" style={{ width }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-[12px] font-semibold text-blue-400">
          Task Changes
        </span>
        <button
          onClick={onClose}
          className="ml-0.5 rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <button
          onClick={fetchChanges}
          className="rounded p-1 text-neutral-600 transition-colors hover:text-neutral-400"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Summary toolbar */}
      <div className="flex items-center gap-3 border-b border-[#1e1e1e] px-4 pb-2">
        <span className="text-[11px] text-neutral-500">
          {changes.length} file{changes.length !== 1 ? 's' : ''}
        </span>
        {totalAdded > 0 && <span className="text-[10px] text-green-500">+{totalAdded}</span>}
        {totalModified > 0 && <span className="text-[10px] text-amber-400">~{totalModified}</span>}
        {totalDeleted > 0 && <span className="text-[10px] text-red-400">-{totalDeleted}</span>}

        <div className="flex-1" />

        <span className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[11px] text-neutral-500">
          Unified
        </span>
        <button
          className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300"
        >
          Agent Review
        </button>
      </div>

      {/* File list + diffs */}
      <div className="flex-1 overflow-y-auto">
        {loading && changes.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader className="h-4 w-4 animate-spin text-neutral-600" />
          </div>
        ) : changes.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-neutral-700">No changes</p>
        ) : (
          changes.map(file => {
            const isExpanded = expandedFiles.has(file.path);
            const diff = diffs[file.path];
            const isDiffLoading = diffLoading === file.path;

            return (
              <div key={file.path} className="border-b border-[#1a1a1a]">
                {/* File header */}
                <div className="flex items-center gap-2 px-4 py-1.5">
                  <button
                    onClick={() => toggleExpanded(file.path)}
                    className="shrink-0 text-neutral-600 hover:text-neutral-400"
                  >
                    {isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5" />
                      : <ChevronRight className="h-3.5 w-3.5" />
                    }
                  </button>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotColor(file.status)}`} />
                  <FileDiff className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
                  <button
                    onClick={() => toggleExpanded(file.path)}
                    className="min-w-0 flex-1 truncate text-left text-[12px] text-neutral-300 hover:text-white"
                  >
                    {file.path}
                  </button>
                  <span className={`shrink-0 text-[10px] font-mono ${statusTextColor(file.status)}`}>
                    {statusIcon(file.status)}
                  </span>
                  {revertConfirm === file.path ? (
                    <button
                      onClick={() => revertFile(file.path)}
                      disabled={reverting === file.path}
                      className="shrink-0 rounded bg-red-600/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-600/30 disabled:opacity-50"
                    >
                      {reverting === file.path ? 'Reverting...' : 'Confirm'}
                    </button>
                  ) : (
                    <button
                      onClick={() => setRevertConfirm(file.path)}
                      className="shrink-0 rounded p-0.5 text-neutral-700 transition-colors hover:text-red-400"
                      title="Revert file"
                    >
                      <Undo2 className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* Expanded diff */}
                {isExpanded && (
                  <div className="overflow-x-auto bg-[#0d0d0d]">
                    {isDiffLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader className="h-3.5 w-3.5 animate-spin text-neutral-600" />
                      </div>
                    ) : diff ? (
                      <DiffView diff={diff} />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Instance info footer */}
      {instance && (
        <div className="flex items-center gap-2 border-t border-[#1e1e1e] px-4 py-2">
          <span className="truncate text-[11px] text-neutral-600">
            {instance.taskDescription ?? instance.projectName}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Inline diff viewer with line numbers ---

function DiffView({ diff }: { diff: string }) {
  if (!diff || diff === '(no diff available)' || diff === '(failed to load diff)') {
    return <p className="px-4 py-3 text-[11px] text-neutral-600">{diff || 'No diff'}</p>;
  }

  const rawLines = diff.split('\n');

  const parsed: { line: string; oldNum?: number; newNum?: number; type: 'context' | 'added' | 'removed' | 'header' | 'meta' }[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      parsed.push({ line, type: 'header' });
    } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
      parsed.push({ line, type: 'meta' });
    } else if (line.startsWith('+')) {
      parsed.push({ line: line.slice(1), oldNum: undefined, newNum: newLine, type: 'added' });
      newLine++;
    } else if (line.startsWith('-')) {
      parsed.push({ line: line.slice(1), oldNum: oldLine, newNum: undefined, type: 'removed' });
      oldLine++;
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      if (oldLine > 0 || newLine > 0) {
        parsed.push({ line: content, oldNum: oldLine, newNum: newLine, type: 'context' });
        oldLine++;
        newLine++;
      }
    }
  }

  return (
    <table className="w-full border-collapse font-mono text-[11px] leading-[18px]">
      <tbody>
        {parsed.map((p, i) => {
          if (p.type === 'meta') return null;
          if (p.type === 'header') {
            const match = p.line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
            const rest = match?.[5]?.trim();
            return (
              <tr key={i}>
                <td colSpan={4} className="border-y border-dashed border-[#1e1e1e] px-4 py-1 text-center text-[10px] text-neutral-600">
                  {rest || p.line}
                </td>
              </tr>
            );
          }

          const bgClass = p.type === 'removed' ? 'bg-red-950/15'
            : p.type === 'added' ? 'bg-green-950/15'
            : '';
          const numColor = p.type === 'context' ? 'text-neutral-700' : 'text-neutral-600';
          const textColor = p.type === 'removed' ? 'text-red-400/80'
            : p.type === 'added' ? 'text-green-400/90'
            : 'text-neutral-500';
          const sign = p.type === 'removed' ? '-' : p.type === 'added' ? '+' : ' ';
          const signColor = p.type === 'removed' ? 'text-red-500' : p.type === 'added' ? 'text-green-600' : 'text-transparent';

          return (
            <tr key={i} className={bgClass}>
              <td className={`w-8 select-none border-r border-[#1a1a1a] px-1.5 text-right ${numColor}`}>
                {p.oldNum ?? ''}
              </td>
              <td className={`w-8 select-none border-r border-[#1a1a1a] px-1.5 text-right ${numColor}`}>
                {p.newNum ?? ''}
              </td>
              <td className={`w-4 select-none px-0.5 text-center ${signColor}`}>{sign}</td>
              <td className={`whitespace-pre-wrap break-all px-2 ${textColor}`}>{p.line || ' '}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
