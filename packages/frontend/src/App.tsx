import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { MessageSquare, GitBranch, PanelLeft, PanelRight, Loader, CheckCircle2, Circle, AlertCircle, Pause, Search, AlertTriangle } from 'lucide-react';
import { useHotkeys } from './hooks/useHotkeys';
import { useSocket } from './hooks/useSocket';
import type { InstanceStatus, AgentTask } from './types';
import TaskSidebar from './components/TaskSidebar';
import Sidebar from './components/Sidebar';
import ResizeHandle from './components/ResizeHandle';
import ChatView from './components/ChatView';
import TaskChangesPanel from './components/TaskChangesPanel';
import ScanPathsModal from './components/ScanPathsModal';
import LaunchModal from './components/LaunchModal';
import { useProjects } from './hooks/useProjects';
import { useInstances } from './hooks/useInstances';
import { useConfig } from './hooks/useConfig';
import { useAttentionQueue } from './hooks/useAttentionQueue';
import { useTaskHistory } from './hooks/useTaskHistory';
import { useRtk } from './hooks/useRtk';
import RtkStatusIndicator from './components/RtkStatusIndicator';

export default function App() {
  const { config, updateConfig } = useConfig();
  const { projects, loading: projectsLoading, refreshing: projectsRefreshing, refreshProjects, deleteWorktree } = useProjects();
  const { instances, spawnInstance, killInstance, refetch: refetchInstances } = useInstances();
  const { tasks: historyTasks, fetchTasks, removeTask, resumeTask } = useTaskHistory();
  const { status: rtkStatus, stats: rtkStats, loading: rtkLoading, installing: rtkInstalling, installHooks, uninstallHooks, dismissed: rtkDismissed, dismiss: dismissRtk } = useRtk();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const typingLocked = !!(selectedInstanceId && (drafts[selectedInstanceId] ?? '').length > 0);
  const [scanPathsOpen, setScanPathsOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  const socket = useSocket();

  // Agent activity tracking — keyed by instanceId → array of active agents
  const [agentTasks, setAgentTasks] = useState<Record<string, AgentTask[]>>({});

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

  const { queue } = useAttentionQueue({
    instances,
    selectedInstanceId,
    onSelectInstance: setSelectedInstanceId,
    typingLocked,
  });

  const queuedIds = useMemo(
    () => new Set(queue.map(q => q.instanceId)),
    [queue],
  );

  const handleLaunch = useCallback(async (projectPath: string, taskDescription?: string) => {
    try {
      const instance = await spawnInstance(projectPath, taskDescription);
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
  ], [sortedActive, selectedInstance, selectedInstanceId, queue, handleKill]));

  // Sidebar toggle + resizable widths
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(280);
  const [taskChangesInstanceId, setTaskChangesInstanceId] = useState<string | null>(null);
  const [changesWidth, setChangesWidth] = useState(480);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth(prev => Math.min(400, Math.max(160, prev + delta)));
  }, []);

  const handleRightResize = useCallback((delta: number) => {
    setRightWidth(prev => Math.min(450, Math.max(180, prev + delta)));
  }, []);

  const handleChangesResize = useCallback((delta: number) => {
    // Dragging left = wider panel (negative delta from "right" side handle → invert)
    setChangesWidth(prev => Math.min(900, Math.max(320, prev + delta)));
  }, []);

  return (
    <div className="flex h-screen flex-col bg-[#0d0d0d]">
      {/* Topbar — full width, same bg as root */}
      <div className="flex h-10 shrink-0 items-center px-4">
        {/* Left: logo + project + branch */}
        <div className="flex shrink-0 items-center gap-3">
          <img src="/favicon.png" alt="Logo" className="h-4 w-4 invert opacity-60" />
          <span className="text-[13px] font-medium text-neutral-300">
            {selectedInstance ? selectedInstance.projectName : 'Claude ADE'}
          </span>
          {selectedInstance?.branchName && (
            <>
              <GitBranch className="h-3 w-3 text-neutral-600" />
              <span className="text-[12px] text-neutral-500">{selectedInstance.branchName}</span>
            </>
          )}
        </div>

        {/* Status indicator + task description */}
        {selectedInstance && (
          <>
            <span className="mx-3 text-neutral-800">|</span>
            <StatusIcon status={selectedInstance.status} />
            {selectedInstance.taskDescription && (
              <div className="mx-3 min-w-0 flex-1">
                <span className="block truncate text-[12px] text-neutral-500">
                  {selectedInstance.taskDescription}
                </span>
              </div>
            )}
          </>
        )}

        {/* Right: rate limit + queue count + sidebar toggles */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
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
          {rateLimitInfo && (
            <span className="flex items-center gap-1.5 rounded-md bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-400/80">
              <AlertTriangle className="h-3 w-3" />
              Rate limited
              {rateLimitInfo.resetsAt && (
                <span className="text-amber-500/50">
                  · {new Date(rateLimitInfo.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </span>
          )}
          {queue.length > 0 && (
            <span className="text-[11px] text-neutral-500">
              {queue.length} waiting
            </span>
          )}
          <button
            onClick={() => setLeftOpen(prev => !prev)}
            className={`rounded p-1 transition-colors hover:text-neutral-300 ${leftOpen ? 'text-neutral-400' : 'text-neutral-600'}`}
            title={leftOpen ? 'Hide tasks' : 'Show tasks'}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setRightOpen(prev => !prev)}
            className={`rounded p-1 transition-colors hover:text-neutral-300 ${rightOpen ? 'text-neutral-400' : 'text-neutral-600'}`}
            title={rightOpen ? 'Collapse files' : 'Expand files'}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body — 3-column layout */}
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        {/* Left sidebar — Tasks */}
        {leftOpen && (
          <>
            <TaskSidebar
              instances={instances}
              selectedId={selectedInstanceId}
              queuedIds={queuedIds}
              historyTasks={historyTasks}
              agentTasks={agentTasks}
              onSelect={setSelectedInstanceId}
              onKill={handleKill}
              onNewTask={() => setNewTaskOpen(true)}
              onResumeTask={handleResumeTask}
              onRemoveTask={handleRemoveTask}
              width={leftWidth}
            />
            <ResizeHandle side="left" onResize={handleLeftResize} />
          </>
        )}

        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden rounded-xl bg-[#161616]">
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
              draft={drafts[selectedInstance.id] ?? ''}
              onDraftChange={handleDraftChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-xs text-center">
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#1e1e1e]">
                  <MessageSquare className="h-7 w-7 text-neutral-600" />
                </div>
                <p className="text-[15px] font-medium text-neutral-400">
                  No task selected
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-neutral-600">
                  Create a new task from the sidebar or select a project from the Projects panel.
                </p>
              </div>
            </div>
          )}
          </div>
        </main>

        {/* Task Changes panel — opens between main and right sidebar */}
        {taskChangesInstanceId && (
          <>
            <ResizeHandle side="right" onResize={handleChangesResize} />
            <TaskChangesPanel
              instanceId={taskChangesInstanceId}
              instances={instances}
              width={changesWidth}
              onClose={() => setTaskChangesInstanceId(null)}
            />
          </>
        )}

        {rightOpen && <ResizeHandle side="right" onResize={handleRightResize} />}

        {/* Right sidebar — Files */}
        <Sidebar
          projects={projects}
          projectsLoading={projectsLoading}
          projectsRefreshing={projectsRefreshing}
          instances={instances}
          scanPaths={config?.scanPaths ?? []}
          onRefreshProjects={refreshProjects}
          onLaunchProject={handleLaunch}
          onDeleteWorktree={handleDeleteWorktree}
          onOpenScanPaths={() => setScanPathsOpen(true)}
          onOpenTaskChanges={setTaskChangesInstanceId}
          width={rightWidth}
          collapsed={!rightOpen}
          onExpand={() => setRightOpen(true)}
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

      {scanPathsOpen && (
        <ScanPathsModal
          scanPaths={config?.scanPaths ?? []}
          onSave={handleSaveScanPaths}
          onClose={() => setScanPathsOpen(false)}
        />
      )}
    </div>
  );
}

// Status indicator for the top bar
function StatusIcon({ status }: { status: InstanceStatus }) {
  switch (status) {
    case 'processing':
      return <Loader className="h-4 w-4 animate-spin text-blue-400" />;
    case 'waiting_input':
      return <Pause className="h-4 w-4 text-green-400" />;
    case 'idle':
      return <Circle className="h-4 w-4 text-neutral-500" />;
    case 'exited':
      return <CheckCircle2 className="h-4 w-4 text-neutral-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-neutral-600" />;
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
  onLaunch: (projectPath: string, taskDescription?: string) => void;
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
        className="mx-4 flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-[#1e1e1e] bg-[#111111] shadow-2xl"
        style={{ maxHeight: '420px' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search */}
        <div className="border-b border-[#1e1e1e] px-4 py-3">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-neutral-600" />
            <input
              type="text"
              placeholder="Pick a project..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              autoFocus
              className="w-full bg-transparent text-[14px] text-neutral-300 placeholder-neutral-600 outline-none"
            />
          </div>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-neutral-700">No projects found</p>
          ) : (
            filtered.map(project => (
              <button
                key={project.path}
                onClick={() => setSelected(project)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[#1a1a1a]"
              >
                <span className="truncate text-[13px] text-neutral-300">{project.name}</span>
                {project.gitBranch && (
                  <span className="ml-auto shrink-0 text-[11px] text-neutral-600">{project.gitBranch}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
