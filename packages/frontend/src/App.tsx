import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { MessageSquare, GitBranch, PanelLeft, PanelRight, Loader, CheckCircle2, Circle, AlertCircle, Pause, Search, AlertTriangle, Settings } from 'lucide-react';
import { useHotkeys } from './hooks/useHotkeys';
import { useSocket } from './hooks/useSocket';
import type { InstanceStatus, AgentTask } from './types';
import TaskSidebar from './components/TaskSidebar';
import Sidebar from './components/Sidebar';
import ResizeHandle from './components/ResizeHandle';
import ChatView from './components/ChatView';
import TaskChangesPanel from './components/TaskChangesPanel';
import TerminalPanel from './components/TerminalPanel';
import CodeSearchModal from './components/CodeSearchModal';
import ScanPathsModal from './components/ScanPathsModal';
import LaunchModal from './components/LaunchModal';
import { useProjects } from './hooks/useProjects';
import { useInstances } from './hooks/useInstances';
import { useConfig } from './hooks/useConfig';
import { useAttentionQueue } from './hooks/useAttentionQueue';
import { useTaskHistory } from './hooks/useTaskHistory';
import { useTaskWarmup } from './hooks/useTaskWarmup';
import { useRtk } from './hooks/useRtk';
import RtkStatusIndicator from './components/RtkStatusIndicator';
import SettingsModal from './components/SettingsModal';
import { useTheme } from './contexts/ThemeContext';

// Returns true for PANEL_TRANSITION_MS after `value` changes. Lets us enable
// CSS width/margin transitions only during open/close toggles while leaving
// resize-drag (which only mutates width, not the toggle) unanimated.
// Uses useLayoutEffect so the transition class lands in the same paint frame
// as the width change — with a plain useEffect the browser commits the new
// width first, then gets the class one paint later, swallowing the animation.
const PANEL_TRANSITION_MS = 280;
function useTransitionFlag(value: unknown): boolean {
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    setActive(true);
    const t = setTimeout(() => setActive(false), PANEL_TRANSITION_MS);
    return () => clearTimeout(t);
  }, [value]);
  return active;
}

export default function App() {
  const { theme } = useTheme();
  const { config, updateConfig } = useConfig();
  const { projects, loading: projectsLoading, refreshing: projectsRefreshing, refreshProjects, deleteWorktree } = useProjects();
  const { instances, loading: instancesLoading, spawnInstance, killInstance, refetch: refetchInstances, patchInstance } = useInstances();
  const { tasks: historyTasks, fetchTasks, removeTask, resumeTask } = useTaskHistory();
  const { status: rtkStatus, stats: rtkStats, loading: rtkLoading, installing: rtkInstalling, installHooks, uninstallHooks, dismissed: rtkDismissed, dismiss: dismissRtk } = useRtk();
  const [selectedInstanceId, setSelectedInstanceIdRaw] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const setSelectedInstanceId = useCallback((id: string | null | ((prev: string | null) => string | null)) => {
    setRestored(true);
    setSelectedInstanceIdRaw(id);
  }, []);

  // Restore last-selected task from config once the instances fetch has
  // settled. Using state (not a ref) so useAttentionQueue can be suspended
  // until restoration runs — otherwise the queue's auto-select steals the
  // selection before config arrives and the persist effect below writes
  // the wrong id back.
  useEffect(() => {
    if (restored) return;
    if (!config) return;
    if (instancesLoading) return;
    const stored = config.lastSelectedTaskId ?? null;
    if (stored && instances.some(i => i.id === stored)) {
      setSelectedInstanceIdRaw(stored);
    }
    setRestored(true);
  }, [config, instances, instancesLoading, restored]);

  useEffect(() => {
    if (!restored) return;
    if (config?.lastSelectedTaskId === selectedInstanceId) return;
    updateConfig({ lastSelectedTaskId: selectedInstanceId }).catch(() => {});
  }, [restored, selectedInstanceId, config, updateConfig]);

  // If the restored selection points to a task that no longer exists
  // (deleted between sessions), clear it.
  useEffect(() => {
    if (!selectedInstanceId) return;
    if (instances.length === 0) return;
    if (!instances.some(i => i.id === selectedInstanceId)) {
      setSelectedInstanceId(null);
    }
  }, [instances, selectedInstanceId]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [scanPathsOpen, setScanPathsOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  const socket = useSocket();

  // Agent activity tracking — keyed by instanceId → array of active agents
  const [agentTasks, setAgentTasks] = useState<Record<string, AgentTask[]>>({});

  // Warm up a task the first time it's selected, and keep the prefetch
  // running even if the user switches away (ChatView unmounts per task).
  const { warm, warmingIds, results: warmupResults } = useTaskWarmup();
  useEffect(() => {
    if (selectedInstanceId) warm(selectedInstanceId);
  }, [selectedInstanceId, warm]);

  // Global rate limit state (from any instance)
  const [rateLimitInfo, setRateLimitInfo] = useState<{ status: string; resetsAt?: number; rateLimitType?: string } | null>(null);

  // Listen for agent events and rate limits globally
  useEffect(() => {
    const onAgentEvent = (data: {
      instanceId: string; event: string; taskId?: string; toolUseId?: string;
      description?: string; taskType?: string; status?: string;
      lastToolName?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
    }) => {
      const { instanceId, event: evt, taskId, toolUseId, description, lastToolName, usage } = data;
      if (!taskId || !toolUseId) return;

      setAgentTasks(prev => {
        const current = prev[instanceId] ?? [];
        if (evt === 'started') {
          // Add new agent task if not already tracked
          if (current.some(a => a.taskId === taskId)) return prev;
          return {
            ...prev,
            [instanceId]: [...current, {
              taskId,
              toolUseId,
              description: description ?? 'Agent',
              status: 'running',
              startedAt: Date.now(),
            }],
          };
        }
        if (evt === 'progress') {
          return {
            ...prev,
            [instanceId]: current.map(a =>
              a.taskId === taskId
                ? { ...a, description: description ?? a.description, lastToolName, usage }
                : a,
            ),
          };
        }
        if (evt === 'completed') {
          const agentStatus = (data.status === 'error' || data.status === 'failed') ? 'failed' as const : 'completed' as const;
          if (agentStatus === 'failed') {
            // Show failed state for 10s, then remove
            setTimeout(() => {
              setAgentTasks(p => ({
                ...p,
                [instanceId]: (p[instanceId] ?? []).filter(a => a.taskId !== taskId),
              }));
            }, 10000);
            return {
              ...prev,
              [instanceId]: current.map(a =>
                a.taskId === taskId ? { ...a, status: 'failed', description: description ?? a.description, failedAt: Date.now() } : a,
              ),
            };
          }
          return {
            ...prev,
            [instanceId]: current.filter(a => a.taskId !== taskId),
          };
        }
        return prev;
      });
    };

    const onRateLimit = (data: { instanceId: string; status: string; resetsAt?: number; rateLimitType?: string }) => {
      setRateLimitInfo({ status: data.status, resetsAt: data.resetsAt, rateLimitType: data.rateLimitType });
      if (data.resetsAt) {
        const delay = (data.resetsAt * 1000) - Date.now();
        if (delay > 0 && delay < 600_000) {
          setTimeout(() => setRateLimitInfo(null), delay + 1000);
        }
      }
    };

    socket.on('agent:event', onAgentEvent);
    socket.on('chat:rate_limit', onRateLimit);
    return () => {
      socket.off('agent:event', onAgentEvent);
      socket.off('chat:rate_limit', onRateLimit);
    };
  }, [socket]);

  const { queue } = useAttentionQueue({ instances });

  const queuedIds = useMemo(
    () => new Set(queue.map(q => q.instanceId)),
    [queue],
  );

  const handleLaunch = useCallback(async (projectPath: string, taskDescription?: string, branchName?: string, useWorktree?: boolean) => {
    try {
      const instance = await spawnInstance(projectPath, taskDescription, branchName, useWorktree);
      setSelectedInstanceId(instance.id);
      setNewTaskOpen(false);
      fetchTasks();
      if (taskDescription) {
        refreshProjects();
      }
    } catch {
      // Error already logged in hook
    }
  }, [spawnInstance, refreshProjects]);

  const handleKill = useCallback(async (id: string, deleteWt?: boolean) => {
    await killInstance(id, deleteWt);
    if (selectedInstanceId === id) {
      setSelectedInstanceId(null);
    }
    if (deleteWt) {
      refreshProjects();
    }
    fetchTasks();
  }, [killInstance, selectedInstanceId, refreshProjects, fetchTasks]);

  const handleResumeTask = useCallback(async (taskId: string) => {
    try {
      const instance = await resumeTask(taskId);
      await refetchInstances();
      setSelectedInstanceId(instance.id);
    } catch {
      // Error logged in hook
    }
  }, [resumeTask, refetchInstances]);

  const handleRemoveTask = useCallback(async (taskId: string) => {
    await removeTask(taskId);
  }, [removeTask]);

  const handleDeleteWorktree = useCallback(async (projectPath: string, worktreePath: string) => {
    await deleteWorktree(projectPath, worktreePath);
  }, [deleteWorktree]);



  const handleSaveScanPaths = useCallback(async (paths: string[]) => {
    try {
      await updateConfig({ scanPaths: paths });
      refreshProjects();
      setScanPathsOpen(false);
    } catch {
      // Error already logged in hook
    }
  }, [updateConfig, refreshProjects]);

  useEffect(() => {
    if (!projectsLoading && projects.length === 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setScanPathsOpen(true);
    }
  }, [projectsLoading, projects.length]);

  const selectedInstance = instances.find(i => i.id === selectedInstanceId);

  // Ref to ChatView's sendMessage for hotkey-driven sends
  const chatSendRef = useRef<{ sendMessage: (text: string) => void } | null>(null);

  const handleDraftChange = useCallback((value: string) => {
    if (!selectedInstanceId) return;
    setDrafts(prev => ({ ...prev, [selectedInstanceId]: value }));
  }, [selectedInstanceId]);

  // Sorted active instances for Cmd+N switching
  const sortedActive = useMemo(
    () => [...instances].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [instances],
  );

  // Keyboard shortcuts
  useHotkeys(useMemo(() => [
    // Cmd+1..9 — switch between instances
    ...Array.from({ length: 9 }, (_, i) => ({
      key: `Meta+${i + 1}`,
      handler: () => {
        const target = sortedActive[i];
        if (target) setSelectedInstanceId(target.id);
      },
    })),
    // Cmd+Enter — send "yes" to active instance
    {
      key: 'Meta+Enter',
      handler: () => chatSendRef.current?.sendMessage('yes'),
      enabled: selectedInstance?.status === 'waiting_input',
    },
    // Cmd+Shift+W — kill active instance
    {
      key: 'Meta+Shift+w',
      handler: () => {
        if (selectedInstanceId && selectedInstance?.status !== 'exited') {
          handleKill(selectedInstanceId);
        }
      },
      enabled: !!selectedInstanceId,
    },
    // Tab — cycle attention queue (only when not focused on input)
    {
      key: 'Tab',
      handler: () => {
        if (queue.length === 0) return;
        const currentIdx = queue.findIndex(q => q.instanceId === selectedInstanceId);
        const nextIdx = (currentIdx + 1) % queue.length;
        setSelectedInstanceId(queue[nextIdx].instanceId);
      },
      enabled: queue.length > 0,
    },
    // Cmd+N — new task
    {
      key: 'Meta+n',
      handler: () => setNewTaskOpen(true),
    },
    // Cmd+Shift+F — code search
    {
      key: 'Meta+Shift+f',
      handler: () => {
        if (selectedInstance) setCodeSearchOpen(true);
      },
      enabled: !!selectedInstance,
    },
  ], [sortedActive, selectedInstance, selectedInstanceId, queue, handleKill]));

  // Sidebar toggle + resizable widths
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(280);
  const [changesWidth, setChangesWidth] = useState(480);
  // Independent open state for each tab in the combined panel
  const [changesInstanceId, setChangesInstanceId] = useState<string | null>(null);
  const [viewerInstanceId, setViewerInstanceId] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFileTab, setActiveFileTab] = useState<string | null>(null);
  const [scrollToLine, setScrollToLine] = useState<number | undefined>(undefined);
  const [codeSearchOpen, setCodeSearchOpen] = useState(false);
  const [codeSelection, setCodeSelection] = useState<{ filePath: string; startLine: number; endLine: number; code: string } | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(480);

  // The panel is open if either tab is open
  const panelInstanceId = changesInstanceId ?? viewerInstanceId;
  const showChanges = !!changesInstanceId;

  // Cache the last non-null panel id so the panel keeps rendering during its
  // slide-out animation (wrapper width transitions to 0 while content fades).
  const lastPanelInstanceIdRef = useRef<string | null>(panelInstanceId);
  if (panelInstanceId) lastPanelInstanceIdRef.current = panelInstanceId;
  const renderPanelInstanceId = panelInstanceId ?? lastPanelInstanceIdRef.current;

  // Enable CSS width/margin transitions only when an open/close toggle fires.
  // Otherwise resize-drag would re-trigger a 260ms width animation on every
  // mousemove, making the drag feel laggy.
  const leftTransitioning = useTransitionFlag(leftOpen);
  const changesTransitioning = useTransitionFlag(!!panelInstanceId);
  const terminalTransitioning = useTransitionFlag(terminalOpen);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth(prev => Math.min(400, Math.max(160, prev + delta)));
  }, []);

  const handleRightResize = useCallback((delta: number) => {
    setRightWidth(prev => Math.min(450, Math.max(180, prev + delta)));
  }, []);

  const handleChangesResize = useCallback((delta: number) => {
    setChangesWidth(prev => Math.min(900, Math.max(320, prev + delta)));
  }, []);

  const handleTerminalResize = useCallback((delta: number) => {
    setTerminalWidth(prev => Math.min(900, Math.max(320, prev + delta)));
  }, []);

  const handleOpenTerminal = useCallback(() => {
    setTerminalOpen(prev => !prev);
  }, []);

  const handleCloseTerminal = useCallback(() => {
    setTerminalOpen(false);
  }, []);

  const handleOpenTaskChanges = useCallback((instanceId: string) => {
    setChangesInstanceId(instanceId);
    // If viewer is open for a different instance, keep it; same instance is fine
  }, []);

  const handleCloseChanges = useCallback(() => {
    setChangesInstanceId(null);
  }, []);

  const handleCloseFile = useCallback((filePath: string) => {
    setOpenFiles(prev => {
      const next = prev.filter(f => f !== filePath);
      // If we closed the active tab, switch to the last remaining file or null
      if (activeFileTab === filePath) {
        setActiveFileTab(next.length > 0 ? next[next.length - 1] : null);
      }
      if (next.length === 0) setViewerInstanceId(null);
      return next;
    });
  }, [activeFileTab]);

  const handleCloseAllFiles = useCallback(() => {
    setOpenFiles([]);
    setActiveFileTab(null);
    setViewerInstanceId(null);
  }, []);

  const handleClosePanel = useCallback(() => {
    setChangesInstanceId(null);
    setViewerInstanceId(null);
    setOpenFiles([]);
    setActiveFileTab(null);
  }, []);

  const handleOpenFileViewer = useCallback((projectPath: string, projectName: string, filePath?: string, line?: number) => {
    const match = instances.find(i =>
      i.status !== 'exited' && (i.projectPath === projectPath || i.worktreePath === projectPath),
    );
    const targetId = match?.id ?? selectedInstanceId;
    if (targetId && filePath) {
      setViewerInstanceId(targetId);
      setOpenFiles(prev => prev.includes(filePath) ? prev : [...prev, filePath]);
      setActiveFileTab(filePath);
      setScrollToLine(line);
    }
  }, [instances, selectedInstanceId]);

  const handleSearchSelect = useCallback((filePath: string, line: number) => {
    if (!selectedInstance) return;
    const projectPath = selectedInstance.worktreePath ?? selectedInstance.projectPath;
    handleOpenFileViewer(projectPath, selectedInstance.projectName, filePath, line);
  }, [selectedInstance, handleOpenFileViewer]);

  // Stable callbacks for memoized children (avoids breaking React.memo on every render)
  const handleNewTask = useCallback(() => setNewTaskOpen(true), []);
  const handleClearCodeSelection = useCallback(() => setCodeSelection(null), []);
  const handleScrollDone = useCallback(() => setScrollToLine(undefined), []);
  const handleOpenScanPaths = useCallback(() => setScanPathsOpen(true), []);
  const handleExpandRight = useCallback(() => setRightOpen(true), []);
  const handleOpenFile = useCallback((filePath: string) => {
    setOpenFiles(prev => prev.includes(filePath) ? prev : [...prev, filePath]);
    setActiveFileTab(filePath);
  }, []);
  const handleCodeClick = useCallback(async (filePath: string, line?: number) => {
    if (!selectedInstance) return;
    const projectPath = selectedInstance.worktreePath ?? selectedInstance.projectPath;
    if (filePath.includes('/')) {
      handleOpenFileViewer(projectPath, selectedInstance.projectName, filePath, line);
      return;
    }
    try {
      const res = await fetch(`/api/projects/files?path=${encodeURIComponent(projectPath)}`);
      if (!res.ok) return;
      const data = await res.json() as { files: string[] };
      const fileName = filePath.toLowerCase();
      const match = data.files.find(f => f.toLowerCase().endsWith(`/${fileName}`) || f.toLowerCase() === fileName);
      if (match) {
        handleOpenFileViewer(projectPath, selectedInstance.projectName, match, line);
      }
    } catch { /* skip */ }
  }, [selectedInstance, handleOpenFileViewer]);

  return (
    <div className="flex h-full flex-col bg-root">
      {/* Topbar — full width, same bg as root */}
      <div className={`flex h-10 shrink-0 items-center px-4 ${(window as any).electronAPI ? 'pl-20' : ''}`} style={(window as any).electronAPI ? { WebkitAppRegion: 'drag' } as React.CSSProperties : undefined}>
        {/* Left: logo + project + branch (pl-20 clears macOS traffic lights in Electron) */}
        <div className="flex shrink-0 items-center gap-3">
          <img src="/favicon.png" alt="Logo" className={`h-4 w-4 opacity-60 ${theme === 'dark' ? 'invert' : ''}`} />
          <span className="text-[13px] font-medium text-secondary">
            {selectedInstance ? selectedInstance.projectName : 'Claude ADE'}
          </span>
          {selectedInstance?.branchName && (
            <>
              <GitBranch className="h-3 w-3 text-faint" />
              <span className="text-[12px] text-muted">{selectedInstance.branchName}</span>
            </>
          )}
        </div>

        {/* Status indicator + task description */}
        {selectedInstance && (
          <>
            <span className="mx-3 text-faint">|</span>
            <StatusIcon status={selectedInstance.status} />
            {selectedInstance.taskDescription && (
              <div className="mx-3 min-w-0 flex-1">
                <span className="block truncate text-[12px] text-muted">
                  {selectedInstance.taskDescription}
                </span>
              </div>
            )}
          </>
        )}

        {/* Right: rate limit + queue count + sidebar toggles */}
        <div className="ml-auto flex shrink-0 items-center gap-2" style={(window as any).electronAPI ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}>
          <RtkStatusIndicator
            status={rtkStatus}
            stats={rtkStats}
            loading={rtkLoading}
            installing={rtkInstalling}
            dismissed={rtkDismissed}
            onInstall={installHooks}
            onUninstall={uninstallHooks}
            onDismiss={dismissRtk}
          />
          {rateLimitInfo && rateLimitInfo.status !== 'allowed' && (
            <span className="flex items-center gap-1.5 rounded-md bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-300/70">
              <AlertTriangle className="h-3 w-3" />
              Rate limit reached.
              {rateLimitInfo.resetsAt && (
                <span className="text-amber-300/70">
                  {' '}Resets {new Date(rateLimitInfo.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.
                </span>
              )}
            </span>
          )}
          {queue.length > 0 && (
            <span className="text-[11px] text-muted">
              {queue.length} waiting
            </span>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded p-1 text-faint transition-colors hover:text-secondary"
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setLeftOpen(prev => !prev)}
            className={`rounded p-1 transition-colors hover:text-secondary ${leftOpen ? 'text-tertiary' : 'text-faint'}`}
            title={leftOpen ? 'Hide tasks' : 'Show tasks'}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setRightOpen(prev => !prev)}
            className={`rounded p-1 transition-colors hover:text-secondary ${rightOpen ? 'text-tertiary' : 'text-faint'}`}
            title={rightOpen ? 'Collapse files' : 'Expand files'}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body — 3-column layout */}
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        {/* Left sidebar — Tasks (width-animated so chat gets pushed) */}
        <div
          className="flex shrink-0 items-stretch gap-2 overflow-hidden panel-transition"
          style={{
            width: leftOpen ? leftWidth + 8 : 0,
            marginRight: leftOpen ? 0 : -8,
          }}
        >
          {(leftOpen || leftTransitioning) && (
            <>
              <TaskSidebar
                instances={instances}
                selectedId={selectedInstanceId}
                queuedIds={queuedIds}
                historyTasks={historyTasks}
                agentTasks={agentTasks}
                warmingIds={warmingIds}
                onSelect={setSelectedInstanceId}
                onKill={handleKill}
                onNewTask={handleNewTask}
                onResumeTask={handleResumeTask}
                onRemoveTask={handleRemoveTask}
                width={leftWidth}
              />
              <ResizeHandle side="left" onResize={handleLeftResize} />
            </>
          )}
        </div>

        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden rounded-xl bg-surface">
          {/* Chat area */}
          <div className="flex-1 overflow-hidden">
          {selectedInstance ? (
            <ChatView
              key={selectedInstance.id}
              instanceId={selectedInstance.id}
              status={selectedInstance.status}
              sendRef={chatSendRef}
              initialModel={selectedInstance.model}
              initialEffort={selectedInstance.effort}
              initialPermissionMode={selectedInstance.permissionMode}
              onSettingsChange={(patch) => patchInstance(selectedInstance.id, patch)}
              draft={drafts[selectedInstance.id] ?? ''}
              onDraftChange={handleDraftChange}
              rateLimitInfo={rateLimitInfo}
              codeSelection={codeSelection}
              onClearCodeSelection={handleClearCodeSelection}
              onCodeClick={handleCodeClick}
              prefetchData={warmupResults[selectedInstance.id]}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-xs text-center">
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-elevated">
                  <MessageSquare className="h-7 w-7 text-faint" />
                </div>
                <p className="text-[15px] font-medium text-tertiary">
                  No task selected
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-faint">
                  Create a new task from the sidebar or select a project from the Projects panel.
                </p>
              </div>
            </div>
          )}
          </div>
        </main>

        {/* Task Changes + File Viewer panel (slides in from the right, pushing chat) */}
        <div
          className="flex shrink-0 items-stretch gap-2 overflow-hidden panel-transition"
          style={{
            width: panelInstanceId ? changesWidth + 8 : 0,
            marginLeft: panelInstanceId ? 0 : -8,
          }}
        >
          <ResizeHandle side="right" onResize={handleChangesResize} />
          {(panelInstanceId || changesTransitioning) && renderPanelInstanceId && (
            <TaskChangesPanel
              instanceId={renderPanelInstanceId}
              instances={instances}
              width={changesWidth}
              onClose={handleClosePanel}
              onCloseChanges={handleCloseChanges}
              onCloseFile={handleCloseFile}
              onCloseAllFiles={handleCloseAllFiles}
              onDeleteWorktree={handleDeleteWorktree}
              openFiles={openFiles}
              activeFileTab={activeFileTab}
              onSelectFileTab={setActiveFileTab}
              showChanges={showChanges}
              scrollToLine={scrollToLine}
              onScrollDone={handleScrollDone}
              onCodeSelect={setCodeSelection}
              onOpenFile={handleOpenFile}
            />
          )}
        </div>

        {/* Terminal panel (slides in from the right, pushing chat).
            `min-h-0` is required so xterm's inner `flex-1 min-h-0` chain
            can resolve to a finite height and produce scrollable output. */}
        <div
          className="flex min-h-0 shrink-0 items-stretch gap-2 overflow-hidden panel-transition"
          style={{
            width: terminalOpen ? terminalWidth + 8 : 0,
            marginLeft: terminalOpen ? 0 : -8,
          }}
        >
          <ResizeHandle side="right" onResize={handleTerminalResize} />
          {(terminalOpen || terminalTransitioning) && (
            <TerminalPanel
              width={terminalWidth}
              cwd={selectedInstance?.worktreePath ?? selectedInstance?.projectPath}
              onClose={handleCloseTerminal}
            />
          )}
        </div>

        {rightOpen && <ResizeHandle side="right" onResize={handleRightResize} />}

        {/* Right sidebar — Files */}
        <Sidebar
          projects={projects}
          projectsLoading={projectsLoading}
          projectsRefreshing={projectsRefreshing}
          instances={instances}
          scanPaths={config?.scanPaths ?? []}
          selectedInstanceId={selectedInstanceId}
          onRefreshProjects={refreshProjects}
          onLaunchProject={handleLaunch}
          onDeleteWorktree={handleDeleteWorktree}
          onOpenScanPaths={handleOpenScanPaths}
          onOpenTaskChanges={handleOpenTaskChanges}
          onOpenFileViewer={handleOpenFileViewer}
          onOpenTerminal={handleOpenTerminal}
          width={rightWidth}
          collapsed={!rightOpen}
          onExpand={handleExpandRight}
        />
      </div>

      {/* New Task modal */}
      {newTaskOpen && (
        <NewTaskPicker
          projects={projects}
          onLaunch={handleLaunch}
          onClose={() => setNewTaskOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}

      {scanPathsOpen && (
        <ScanPathsModal
          scanPaths={config?.scanPaths ?? []}
          onSave={handleSaveScanPaths}
          onClose={() => setScanPathsOpen(false)}
        />
      )}

      {codeSearchOpen && selectedInstance && (
        <CodeSearchModal
          projectPath={selectedInstance.worktreePath ?? selectedInstance.projectPath}
          onSelect={handleSearchSelect}
          onClose={() => setCodeSearchOpen(false)}
        />
      )}
    </div>
  );
}

// Status indicator for the top bar
function StatusIcon({ status }: { status: InstanceStatus }) {
  switch (status) {
    case 'processing':
      return <Loader className="h-4 w-4 animate-spin text-blue-300" />;
    case 'waiting_input':
      return <Pause className="h-4 w-4 text-emerald-300" />;
    case 'idle':
      return <Circle className="h-4 w-4 text-muted" />;
    case 'exited':
      return <CheckCircle2 className="h-4 w-4 text-muted" />;
    default:
      return <AlertCircle className="h-4 w-4 text-faint" />;
  }
}

// Quick project picker for "New Task" from the left sidebar
import type { Project } from './types';

function NewTaskPicker({
  projects,
  onLaunch,
  onClose,
}: {
  projects: Project[];
  onLaunch: (projectPath: string, taskDescription?: string, branchName?: string, useWorktree?: boolean) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Project | null>(null);

  const filtered = filter
    ? projects.filter(p =>
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        p.path.toLowerCase().includes(filter.toLowerCase()),
      )
    : projects;

  // If a project is selected, show the launch modal
  if (selected) {
    return (
      <LaunchModal
        project={selected}
        onLaunch={onLaunch}
        onClose={() => {
          setSelected(null);
          onClose();
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border-default bg-modal shadow-2xl"
        style={{ maxHeight: '420px' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search */}
        <div className="border-b border-border-default px-4 py-3">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-faint" />
            <input
              type="text"
              placeholder="Pick a project..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              autoFocus
              className="w-full bg-transparent text-[14px] text-secondary placeholder-placeholder outline-none"
            />
          </div>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-faint">No projects found</p>
          ) : (
            filtered.map(project => (
              <button
                key={project.path}
                onClick={() => setSelected(project)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover"
              >
                <span className="truncate text-[13px] text-secondary">{project.name}</span>
                {project.gitBranch && (
                  <span className="ml-auto shrink-0 text-[11px] text-faint">{project.gitBranch}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
