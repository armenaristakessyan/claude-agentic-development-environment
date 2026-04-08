import { X, ChevronDown, ChevronRight, Loader, FileDiff, RefreshCw, Undo2, GitBranch, ArrowUpRight, GitMerge, Trash2, Check, AlertTriangle, Copy } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTheme } from '../contexts/ThemeContext';
import type { Instance } from '../types';
import type { GitChange } from './Sidebar';
import { detectLanguage } from './FileViewerPanel';

interface GitStatus {
  branch: string;
  mainBranch: string;
  uncommittedFiles: number;
  commitsAhead: number;
  commitMessages: string[];
  unpushedCount: number;
  hasRemote: boolean;
}

interface TaskChangesPanelProps {
  instanceId: string;
  instances: Instance[];
  width: number;
  onClose: () => void;
  onCloseChanges?: () => void;
  onCloseFile?: (filePath: string) => void;
  onCloseAllFiles?: () => void;
  onDeleteWorktree?: (projectPath: string, worktreePath: string) => void;
  openFiles: string[];
  activeFileTab: string | null;
  onSelectFileTab: (filePath: string) => void;
  showChanges: boolean;
  scrollToLine?: number;
  onScrollDone?: () => void;
  onCodeSelect?: (selection: { filePath: string; startLine: number; endLine: number; code: string }) => void;
}

export default function TaskChangesPanel({ instanceId, instances, width, onClose, onCloseChanges, onCloseFile, onCloseAllFiles, onDeleteWorktree, openFiles, activeFileTab, onSelectFileTab, showChanges, scrollToLine, onScrollDone, onCodeSelect }: TaskChangesPanelProps) {
  const { theme } = useTheme();
  const hasFiles = openFiles.length > 0;
  const [activePanel, setActivePanel] = useState<'changes' | 'file'>(hasFiles && !showChanges ? 'file' : 'changes');
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [revertConfirm, setRevertConfirm] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);

  // Git workflow state
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);
  const [merging, setMerging] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<{ hash: string; mainBranch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrForm, setShowPrForm] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [cleanupConfirm, setCleanupConfirm] = useState(false);

  // File viewer state — cache content per file
  const [fileCache, setFileCache] = useState<Record<string, { content: string | null; loading: boolean; error: string | null }>>({});
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  const instance = instances.find(i => i.id === instanceId);
  const isWorktree = !!instance?.worktreePath;
  const projectPath = instance?.worktreePath ?? instance?.projectPath ?? null;

  const fetchChanges = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/instances/${instanceId}/context/changes`);
      if (res.ok) {
        const data = await res.json() as { files: GitChange[] };
        setChanges(data.files);
        // Auto-select all files for commit
        setSelectedFiles(new Set(data.files.map(f => f.path)));
      }
    } catch { /* skip */ }
    setLoading(false);
  }, [instanceId]);

  const fetchGitStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/instances/${instanceId}/git/status`);
      if (res.ok) {
        const data = await res.json() as GitStatus;
        setGitStatus(data);
        // Auto-fill PR title from task description or branch
        if (!prTitle) {
          setPrTitle(instance?.taskDescription ?? data.branch.replace('claude/', '').replace(/-/g, ' '));
        }
        if (!prBody && data.commitMessages.length > 0) {
          setPrBody(data.commitMessages.map(m => `- ${m}`).join('\n'));
        }
      }
    } catch { /* skip */ }
  }, [instanceId, instance?.taskDescription]);

  useEffect(() => {
    fetchChanges();
    fetchGitStatus();
    const interval = setInterval(() => { fetchChanges(); fetchGitStatus(); }, 10000);
    return () => clearInterval(interval);
  }, [fetchChanges, fetchGitStatus]);

  const toggleExpanded = async (filePath: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) { next.delete(filePath); } else { next.add(filePath); }
      return next;
    });
    if (expandedFiles.has(filePath)) return;
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
        setChanges(prev => prev.filter(f => f.path !== filePath));
        setDiffs(prev => { const next = { ...prev }; delete next[filePath]; return next; });
        setExpandedFiles(prev => { const next = new Set(prev); next.delete(filePath); return next; });
        setSelectedFiles(prev => { const next = new Set(prev); next.delete(filePath); return next; });
      }
    } catch { /* skip */ }
    setReverting(null);
    setRevertConfirm(null);
  };

  const toggleFileSelection = (filePath: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleAllFiles = () => {
    if (selectedFiles.size === changes.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(changes.map(f => f.path)));
    }
  };

  // --- Git workflow actions ---

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMessage.trim(),
          files: selectedFiles.size < changes.length ? [...selectedFiles] : undefined,
        }),
      });
      if (res.ok) {
        setCommitMessage('');
        await fetchChanges();
        await fetchGitStatus();
      } else {
        const data = await res.json() as { error: string };
        setError(data.error);
      }
    } catch {
      setError('Failed to commit');
    }
    setCommitting(false);
  };

  const handlePush = async () => {
    setPushing(true);
    setError(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/git/push`, { method: 'POST' });
      if (res.ok) {
        await fetchGitStatus();
      } else {
        const data = await res.json() as { error: string };
        setError(data.error);
      }
    } catch {
      setError('Failed to push');
    }
    setPushing(false);
  };

  const handleCreatePr = async () => {
    if (!prTitle.trim()) return;
    setCreatingPr(true);
    setError(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/git/create-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: prTitle.trim(),
          body: prBody.trim() || undefined,
          baseBranch: gitStatus?.mainBranch,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { url: string };
        setPrUrl(data.url);
        setShowPrForm(false);
      } else {
        const data = await res.json() as { error: string };
        setError(data.error);
      }
    } catch {
      setError('Failed to create PR');
    }
    setCreatingPr(false);
  };

  const handleMerge = async () => {
    setMerging(true);
    setError(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage: instance?.taskDescription ?? gitStatus?.branch,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { hash: string; mainBranch: string };
        setMergeResult(data);
      } else {
        const data = await res.json() as { error: string };
        setError(data.error);
      }
    } catch {
      setError('Failed to merge');
    }
    setMerging(false);
  };

  const handleCleanup = () => {
    if (!instance?.parentProjectPath || !instance?.worktreePath) return;
    onDeleteWorktree?.(instance.parentProjectPath, instance.worktreePath);
    onClose();
  };

  // When a file tab becomes active, switch panel to file view
  useEffect(() => {
    if (activeFileTab) setActivePanel('file');
  }, [activeFileTab]);

  // Fetch file content when a file tab is selected and not cached
  useEffect(() => {
    if (!activeFileTab || !projectPath) return;
    const cached = fileCache[activeFileTab];
    if (cached) {
      viewerRef.current?.scrollTo(0, 0);
      return;
    }
    setFileCache(prev => ({ ...prev, [activeFileTab]: { content: null, loading: true, error: null } }));
    fetch('/api/projects/file-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, filePath: activeFileTab }),
    })
      .then(res => res.ok ? res.json() as Promise<{ content: string }> : res.json().then(e => Promise.reject(new Error((e as { error: string }).error))))
      .then(data => {
        setFileCache(prev => ({ ...prev, [activeFileTab]: { content: data.content, loading: false, error: null } }));
        viewerRef.current?.scrollTo(0, 0);
      })
      .catch(err => {
        setFileCache(prev => ({ ...prev, [activeFileTab]: { content: null, loading: false, error: err instanceof Error ? err.message : 'Failed to load' } }));
      });
  }, [activeFileTab, projectPath]);

  // Clean cache for closed files
  useEffect(() => {
    setFileCache(prev => {
      const next: typeof prev = {};
      for (const f of openFiles) {
        if (prev[f]) next[f] = prev[f];
      }
      return next;
    });
  }, [openFiles]);

  // Scroll to specific line when requested
  useEffect(() => {
    if (!scrollToLine || !activeFileTab || !viewerRef.current) return;
    const cached = fileCache[activeFileTab];
    if (!cached || cached.loading) return;
    // Wait for SyntaxHighlighter to render, then scroll to the line
    const timer = setTimeout(() => {
      const container = viewerRef.current;
      if (!container) return;
      // SyntaxHighlighter renders lines as rows; approximate line height
      const lineHeight = 18; // 12px font * 1.5 line-height
      const targetY = (scrollToLine - 1) * lineHeight;
      container.scrollTo({ top: Math.max(0, targetY - container.clientHeight / 3), behavior: 'smooth' });
      onScrollDone?.();
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToLine, activeFileTab, fileCache]);

  const handleFileCopy = useCallback((filePath: string) => {
    const cached = fileCache[filePath];
    if (!cached?.content) return;
    navigator.clipboard.writeText(cached.content);
    setCopiedFile(filePath);
    setTimeout(() => setCopiedFile(null), 2000);
  }, [fileCache]);

  // Detect text selection in the file viewer and compute line range
  const handleMouseUp = useCallback(() => {
    if (!activeFileTab || !onCodeSelect) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = sel.toString();
    if (!text.trim()) return;

    const cached = fileCache[activeFileTab];
    if (!cached?.content) return;

    // Find which lines are selected by counting newlines in the content up to the selection
    const container = viewerRef.current;
    if (!container) return;

    const range = sel.getRangeAt(0);
    // Walk up to find code element
    let codeEl = container.querySelector('code');
    if (!codeEl || !codeEl.contains(range.startContainer)) return;

    // Get full text before the selection start
    const preRange = document.createRange();
    preRange.setStart(codeEl, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    const textBefore = preRange.toString();
    const startLine = textBefore.split('\n').length;
    const lineCount = text.split('\n').length;
    const endLine = startLine + lineCount - 1;

    onCodeSelect({
      filePath: activeFileTab,
      startLine,
      endLine,
      code: text,
    });
  }, [activeFileTab, fileCache, onCodeSelect]);

  const totalAdded = changes.filter(f => f.status === 'A' || f.status === '??').length;
  const totalModified = changes.filter(f => f.status === 'M').length;
  const totalDeleted = changes.filter(f => f.status === 'D').length;

  const statusDotColor = (s: string) => {
    if (s === 'M') return 'bg-amber-400/80';
    if (s === 'A' || s === '??') return 'bg-emerald-400/80';
    if (s === 'D') return 'bg-rose-400/80';
    if (s === 'R') return 'bg-blue-400';
    return 'bg-neutral-500';
  };

  const statusTextColor = (s: string) => {
    if (s === 'M') return 'text-amber-300';
    if (s === 'A' || s === '??') return 'text-emerald-300';
    if (s === 'D') return 'text-rose-300';
    if (s === 'R') return 'text-blue-300';
    return 'text-muted';
  };

  const statusIcon = (s: string) => {
    if (s === 'M') return 'M';
    if (s === 'A') return 'A';
    if (s === '??') return 'U';
    if (s === 'D') return 'D';
    if (s === 'R') return 'R';
    return s;
  };

  // Determine which workflow phase we're in
  const hasUncommitted = changes.length > 0;
  const hasCommits = (gitStatus?.commitsAhead ?? 0) > 0;
  const hasUnpushed = (gitStatus?.unpushedCount ?? 0) > 0;

  const activeFileCached = activeFileTab ? fileCache[activeFileTab] : null;
  const activeFileLanguage = activeFileTab ? detectLanguage(activeFileTab) : 'text';
  const activeFileLineCount = activeFileCached?.content ? activeFileCached.content.split('\n').length : 0;

  // Auto-switch panel when one side closes
  useEffect(() => {
    if (!showChanges && activePanel === 'changes' && hasFiles) setActivePanel('file');
    if (!hasFiles && activePanel === 'file' && showChanges) setActivePanel('changes');
  }, [showChanges, hasFiles]);

  return (
    <div className="flex h-full shrink-0 flex-col overflow-hidden rounded-xl bg-surface" style={{ width }}>
      {/* Header — tab bar: file tabs first, Task Changes last */}
      <div className="flex items-center gap-1 overflow-x-auto px-3 py-2">
        {openFiles.map(filePath => {
          const fileName = filePath.split('/').pop() ?? filePath;
          const isActive = activePanel === 'file' && activeFileTab === filePath;
          return (
            <div
              key={filePath}
              className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 transition-colors ${
                isActive
                  ? 'border-violet-500/30 bg-violet-500/10'
                  : 'border-transparent'
              }`}
            >
              <button
                onClick={() => { setActivePanel('file'); onSelectFileTab(filePath); }}
                className={`max-w-[120px] truncate text-[11px] font-medium transition-colors ${
                  isActive ? 'text-violet-300' : 'text-faint hover:text-tertiary'
                }`}
                title={filePath}
              >
                {fileName}
              </button>
              <button
                onClick={() => onCloseFile?.(filePath)}
                className="rounded p-0.5 text-faint/50 transition-colors hover:text-secondary"
                title="Close file"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}
        {showChanges && (
          <div className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 transition-colors ${
            activePanel === 'changes'
              ? 'border-blue-500/30 bg-blue-500/10'
              : 'border-transparent'
          }`}>
            <button
              onClick={() => setActivePanel('changes')}
              className={`text-[11px] font-semibold transition-colors ${
                activePanel === 'changes' ? 'text-blue-300' : 'text-faint hover:text-tertiary'
              }`}
            >
              Task Changes
            </button>
            <button
              onClick={onCloseChanges ?? onClose}
              className="rounded p-0.5 text-faint/50 transition-colors hover:text-secondary"
              title="Close task changes"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )}
        <div className="flex-1" />
      </div>

      {/* === Task Changes tab === */}
      {activePanel === 'changes' && (
        <>
          {/* Summary toolbar */}
          <div className="flex items-center gap-3 border-b border-border-default px-4 pb-2">
            <span className="text-[11px] text-muted">
              {changes.length} file{changes.length !== 1 ? 's' : ''}
            </span>
            {totalAdded > 0 && <span className="text-[10px] text-emerald-300">+{totalAdded}</span>}
            {totalModified > 0 && <span className="text-[10px] text-amber-300">~{totalModified}</span>}
            {totalDeleted > 0 && <span className="text-[10px] text-rose-300">-{totalDeleted}</span>}
            {hasCommits && (
              <span className="text-[10px] text-blue-300">{gitStatus!.commitsAhead} commit{gitStatus!.commitsAhead !== 1 ? 's' : ''} ahead</span>
            )}
            <div className="flex-1" />
            <button
              onClick={() => { fetchChanges(); fetchGitStatus(); }}
              className="shrink-0 rounded p-1 text-faint transition-colors hover:text-tertiary"
              title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Error banner */}
          {error && (
            <div className="flex items-center gap-2 border-b border-rose-800/20 bg-rose-950/15 px-4 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-300" />
              <span className="min-w-0 flex-1 text-[11px] text-rose-300">{error}</span>
              <button onClick={() => setError(null)} className="shrink-0 text-[11px] text-rose-300/70 hover:text-red-300">Dismiss</button>
            </div>
          )}

          {/* File list with checkboxes */}
          <div className="flex-1 overflow-y-auto">
            {loading && changes.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader className="h-4 w-4 animate-spin text-faint" />
              </div>
            ) : changes.length === 0 && !hasCommits ? (
              <p className="py-8 text-center text-[12px] text-faint">No changes</p>
            ) : (
              <>
                {changes.length > 0 && (
                  <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-1.5">
                    <button
                      onClick={toggleAllFiles}
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                        selectedFiles.size === changes.length
                          ? 'border-blue-500 bg-blue-500/70'
                          : selectedFiles.size > 0
                            ? 'border-blue-500/50 bg-blue-500/20'
                            : 'border-border-input'
                      }`}
                    >
                      {selectedFiles.size === changes.length && <Check className="h-2.5 w-2.5 text-white" />}
                    </button>
                    <span className="text-[11px] text-muted">
                      {selectedFiles.size === changes.length ? 'Deselect all' : 'Select all'}
                    </span>
                  </div>
                )}

                {changes.map(file => {
                  const isExpanded = expandedFiles.has(file.path);
                  const diff = diffs[file.path];
                  const isDiffLoading = diffLoading === file.path;
                  const isSelected = selectedFiles.has(file.path);

                  return (
                    <div key={file.path} className="border-b border-border-subtle">
                      <div className="flex items-center gap-2 px-4 py-1.5">
                        <button
                          onClick={() => toggleFileSelection(file.path)}
                          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                            isSelected ? 'border-blue-500 bg-blue-500/70' : 'border-border-input'
                          }`}
                        >
                          {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
                        </button>
                        <button
                          onClick={() => toggleExpanded(file.path)}
                          className="shrink-0 text-faint hover:text-tertiary"
                        >
                          {isExpanded
                            ? <ChevronDown className="h-3.5 w-3.5" />
                            : <ChevronRight className="h-3.5 w-3.5" />
                          }
                        </button>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotColor(file.status)}`} />
                        <button
                          onClick={() => toggleExpanded(file.path)}
                          className="min-w-0 flex-1 truncate text-left text-[12px] text-secondary hover:text-white"
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
                            className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                          >
                            {reverting === file.path ? 'Reverting...' : 'Confirm'}
                          </button>
                        ) : (
                          <button
                            onClick={() => setRevertConfirm(file.path)}
                            className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-rose-300"
                            title="Revert file"
                          >
                            <Undo2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>

                      {isExpanded && (
                        <div className="overflow-x-auto bg-root">
                          {isDiffLoading ? (
                            <div className="flex items-center justify-center py-6">
                              <Loader className="h-3.5 w-3.5 animate-spin text-faint" />
                            </div>
                          ) : diff ? (
                            <DiffView diff={diff} />
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}

                {changes.length === 0 && hasCommits && gitStatus && (
                  <div className="px-4 py-3">
                    <p className="mb-2 text-[11px] font-medium text-muted">Commits on {gitStatus.branch}:</p>
                    {gitStatus.commitMessages.map((msg, i) => (
                      <p key={i} className="text-[12px] text-tertiary">• {msg}</p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Bottom workflow panel */}
          <div className="shrink-0 border-t border-border-default">
            {prUrl && (
              <div className="flex items-center gap-2 bg-emerald-950/15 px-4 py-3">
                <Check className="h-4 w-4 text-emerald-300" />
                <span className="text-[12px] text-emerald-300">PR created!</span>
                <a href={prUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-[12px] text-blue-300 underline hover:text-blue-300">Open PR</a>
              </div>
            )}

            {mergeResult && (
              <div className="space-y-2 bg-emerald-950/15 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-300" />
                  <span className="text-[12px] text-emerald-300">Merged to {mergeResult.mainBranch} ({mergeResult.hash})</span>
                </div>
                {isWorktree && (
                  cleanupConfirm ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-tertiary">Delete worktree and branch?</span>
                      <button onClick={handleCleanup} className="rounded bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20">Yes, clean up</button>
                      <button onClick={() => setCleanupConfirm(false)} className="text-[11px] text-muted hover:text-secondary">Keep</button>
                    </div>
                  ) : (
                    <button onClick={() => setCleanupConfirm(true)} className="flex items-center gap-1.5 text-[11px] text-muted hover:text-secondary">
                      <Trash2 className="h-3 w-3" />
                      Clean up worktree
                    </button>
                  )
                )}
              </div>
            )}

            {showPrForm && !prUrl && (
              <div className="space-y-2 border-b border-border-default px-4 py-3">
                <input type="text" value={prTitle} onChange={e => setPrTitle(e.target.value)} placeholder="PR title..." className="w-full rounded-lg border border-border-input bg-root px-3 py-1.5 text-[12px] text-secondary placeholder-placeholder outline-none" />
                <textarea value={prBody} onChange={e => setPrBody(e.target.value)} placeholder="Description (optional)..." rows={3} className="w-full resize-none rounded-lg border border-border-input bg-root px-3 py-1.5 text-[12px] text-secondary placeholder-placeholder outline-none" />
                <div className="flex items-center gap-2">
                  <button onClick={handleCreatePr} disabled={creatingPr || !prTitle.trim()} className="flex items-center gap-1.5 rounded-lg bg-emerald-500/60 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-emerald-400/60 disabled:opacity-50">
                    {creatingPr ? <Loader className="h-3 w-3 animate-spin" /> : <ArrowUpRight className="h-3 w-3" />}
                    {creatingPr ? 'Creating...' : 'Create PR'}
                  </button>
                  <button onClick={() => setShowPrForm(false)} className="text-[12px] text-muted hover:text-secondary">Cancel</button>
                </div>
              </div>
            )}

            {hasUncommitted && !mergeResult && (
              <div className="space-y-2 px-4 py-3">
                <textarea value={commitMessage} onChange={e => setCommitMessage(e.target.value)} placeholder={instance?.taskDescription ? `${instance.taskDescription}` : 'Commit message...'} rows={2} className="w-full resize-none rounded-lg border border-border-input bg-root px-3 py-1.5 text-[12px] text-secondary placeholder-placeholder outline-none" onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); handleCommit(); } }} />
                <button onClick={handleCommit} disabled={committing || (!commitMessage.trim() && !instance?.taskDescription) || selectedFiles.size === 0} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-500/60 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-blue-500/80 disabled:opacity-50">
                  {committing ? <Loader className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  {committing ? 'Committing...' : `Commit ${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''}`}
                </button>
              </div>
            )}

            {!hasUncommitted && hasCommits && !mergeResult && !prUrl && !showPrForm && (
              <div className="flex flex-col gap-2 px-4 py-3">
                {hasUnpushed && (
                  <button onClick={handlePush} disabled={pushing} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-500/60 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-blue-500/80 disabled:opacity-50">
                    {pushing ? <Loader className="h-3 w-3 animate-spin" /> : <ArrowUpRight className="h-3 w-3" />}
                    {pushing ? 'Pushing...' : `Push ${gitStatus!.unpushedCount} commit${gitStatus!.unpushedCount !== 1 ? 's' : ''}`}
                  </button>
                )}
                <button onClick={() => setShowPrForm(true)} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-green-500/30 px-3 py-1.5 text-[12px] font-medium text-emerald-300 transition-colors hover:bg-green-500/10">
                  <ArrowUpRight className="h-3 w-3" />
                  Create Pull Request
                </button>
                {isWorktree && (
                  <button onClick={handleMerge} disabled={merging} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-purple-500/30 px-3 py-1.5 text-[12px] font-medium text-violet-300 transition-colors hover:bg-purple-500/10 disabled:opacity-50">
                    {merging ? <Loader className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
                    {merging ? 'Merging...' : `Squash merge to ${gitStatus?.mainBranch ?? 'main'}`}
                  </button>
                )}
              </div>
            )}

            {instance && !hasUncommitted && !hasCommits && !mergeResult && !prUrl && (
              <div className="flex items-center gap-2 px-4 py-2">
                <span className="truncate text-[11px] text-faint">{instance.taskDescription ?? instance.projectName}</span>
              </div>
            )}
          </div>
        </>
      )}

      {/* === File tab === */}
      {activePanel === 'file' && activeFileTab && (
        <>
          <div className="flex items-center gap-3 border-b border-border-default px-4 pb-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted font-mono">{activeFileTab}</span>
            {activeFileCached?.content != null && (
              <span className="shrink-0 text-[10px] text-faint">{activeFileLineCount} lines</span>
            )}
            <button onClick={() => handleFileCopy(activeFileTab)} className="shrink-0 rounded p-1 text-faint transition-colors hover:text-tertiary" title="Copy file content">
              {copiedFile === activeFileTab ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>

          <div ref={viewerRef} className="flex-1 overflow-auto" onMouseUp={handleMouseUp}>
            {activeFileCached?.loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader className="h-4 w-4 animate-spin text-faint" />
              </div>
            ) : activeFileCached?.error ? (
              <div className="px-4 py-8 text-center text-[12px] text-rose-300">{activeFileCached.error}</div>
            ) : activeFileCached?.content != null ? (
              <SyntaxHighlighter
                style={theme === 'dark' ? oneDark : oneLight}
                language={activeFileLanguage}
                showLineNumbers
                lineNumberStyle={{ minWidth: '3em', paddingRight: '1em', color: 'var(--text-faint)', userSelect: 'none' }}
                customStyle={{ margin: 0, padding: '8px 0', background: 'transparent', fontSize: '12px', lineHeight: '1.5' }}
                codeTagProps={{ style: { background: 'transparent' } }}
              >
                {activeFileCached.content}
              </SyntaxHighlighter>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

// --- Inline diff viewer with line numbers ---

function DiffView({ diff }: { diff: string }) {
  const { theme } = useTheme();
  const light = theme === 'light';

  if (!diff || diff === '(no diff available)' || diff === '(failed to load diff)') {
    return <p className="px-4 py-3 text-[11px] text-faint">{diff || 'No diff'}</p>;
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
                <td colSpan={4} className="border-y border-dashed border-border-default px-4 py-1 text-center text-[10px] text-faint">
                  {rest || p.line}
                </td>
              </tr>
            );
          }

          const bgClass = p.type === 'removed'
            ? (light ? 'bg-rose-100' : 'bg-rose-950/10')
            : p.type === 'added'
            ? (light ? 'bg-emerald-100' : 'bg-emerald-950/10')
            : '';
          const numColor = p.type === 'context' ? 'text-faint' : 'text-faint';
          const textColor = p.type === 'removed'
            ? (light ? 'text-rose-700' : 'text-rose-300/80')
            : p.type === 'added'
            ? (light ? 'text-emerald-700' : 'text-emerald-300/90')
            : 'text-muted';
          const sign = p.type === 'removed' ? '-' : p.type === 'added' ? '+' : ' ';
          const signColor = p.type === 'removed'
            ? (light ? 'text-rose-500' : 'text-rose-300/70')
            : p.type === 'added'
            ? (light ? 'text-emerald-500' : 'text-emerald-400/60')
            : 'text-transparent';

          return (
            <tr key={i} className={bgClass}>
              <td className={`w-8 select-none border-r border-border-subtle px-1.5 text-right ${numColor}`}>
                {p.oldNum ?? ''}
              </td>
              <td className={`w-8 select-none border-r border-border-subtle px-1.5 text-right ${numColor}`}>
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
