import { useState, useCallback, useRef, useEffect } from 'react';
import { Plus, Search, Trash2, Play, X, Clock, Bot, Loader } from 'lucide-react';
import type { Instance, InstanceStatus, AgentTask } from '../types';
import type { StoredTask } from '../hooks/useTaskHistory';

interface TaskSidebarProps {
  instances: Instance[];
  selectedId: string | null;
  queuedIds: Set<string>;
  historyTasks: StoredTask[];
  agentTasks: Record<string, AgentTask[]>;
  onSelect: (id: string) => void;
  onKill: (id: string, deleteWorktree?: boolean) => void;
  onNewTask: () => void;
  onResumeTask: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  width: number;
}

const STATUS_LABEL: Record<InstanceStatus, string> = {
  processing: 'Working',
  waiting_input: 'Waiting',
  idle: 'Idle',
  exited: 'Done',
};

const STATUS_DOT: Record<InstanceStatus, string> = {
  processing: 'bg-blue-500 animate-pulse',
  waiting_input: 'bg-green-500',
  idle: 'bg-neutral-500',
  exited: 'bg-neutral-600',
};

export default function TaskSidebar({
  instances,
  selectedId,
  queuedIds,
  historyTasks,
  agentTasks,
  onSelect,
  onKill,
  onNewTask,
  onResumeTask,
  onRemoveTask,
  width,
}: TaskSidebarProps) {
  const [filter, setFilter] = useState('');
  const [confirmKillId, setConfirmKillId] = useState<string | null>(null);
  const [deleteWorktreeChecked, setDeleteWorktreeChecked] = useState(false);
  const [historyHeight, setHistoryHeight] = useState(200);
  const dragging = useRef(false);
  const lastY = useRef(0);

  // Active instances sorted newest first
  const activeInstances = [...instances].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // History: exited tasks that are NOT in the active instances list
  const activeIds = new Set(instances.map(i => i.id));
  const history = historyTasks.filter(t => t.status === 'exited' && !activeIds.has(t.id));

  const filteredActive = filter
    ? activeInstances.filter(i =>
        i.projectName.toLowerCase().includes(filter.toLowerCase()) ||
        (i.taskDescription?.toLowerCase().includes(filter.toLowerCase()) ?? false),
      )
    : activeInstances;

  const filteredHistory = filter
    ? history.filter(t =>
        t.projectName.toLowerCase().includes(filter.toLowerCase()) ||
        (t.taskDescription?.toLowerCase().includes(filter.toLowerCase()) ?? false),
      )
    : history;

  const killTarget = instances.find(i => i.id === confirmKillId);
  const hasWorktree = killTarget?.worktreePath !== null && killTarget?.worktreePath !== undefined;

  // Vertical resize for history panel
  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = lastY.current - e.clientY;
    lastY.current = e.clientY;
    setHistoryHeight(prev => Math.min(500, Math.max(80, prev + delta)));
  }, []);

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastY.current = e.clientY;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <aside className="flex h-full shrink-0 flex-col bg-transparent" style={{ width: `${width}px` }}>
      {/* New Task button */}
      <div className="px-3 py-2">
        <button
          onClick={onNewTask}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-neutral-400 transition-colors hover:bg-neutral-800/30 hover:text-neutral-200"
        >
          <Plus className="h-4 w-4" />
          New Task
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1.5 h-3.5 w-3.5 text-neutral-600" />
          <input
            type="text"
            placeholder="Search tasks"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full rounded bg-transparent py-1 pl-7 pr-2 text-[12px] text-neutral-400 placeholder-neutral-600 outline-none transition-colors focus:bg-neutral-900/50"
          />
        </div>
      </div>

      {/* Active tasks — takes remaining space */}
      <div className="flex-1 overflow-y-auto px-2">
        {filteredActive.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-neutral-600">
            {filter ? 'No matching tasks' : 'No tasks yet'}
          </p>
        ) : (
          <div className="flex flex-col gap-px">
            {filteredActive.map(instance => {
              const isSelected = instance.id === selectedId;
              const label = instance.taskDescription || instance.projectName;

              const agents = agentTasks[instance.id] ?? [];

              return (
                <div
                  key={instance.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(instance.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(instance.id); }}
                  className={`group flex w-full cursor-pointer flex-col rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-neutral-800/50'
                      : 'hover:bg-neutral-800/20'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <span className={`block truncate text-[13px] leading-tight ${
                        isSelected ? 'text-neutral-200' : 'text-neutral-400'
                      }`}>
                        {label}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-600">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[instance.status]}`} />
                        {STATUS_LABEL[instance.status]}
                        {(instance.totalCostUsd > 0 || instance.totalInputTokens > 0) && (
                          <span className="ml-1 text-[10px] text-neutral-700">
                            {formatTokens(instance.totalInputTokens + instance.totalOutputTokens)}
                            {instance.totalCostUsd > 0 && ` · $${instance.totalCostUsd.toFixed(4)}`}
                          </span>
                        )}
                      </span>
                    </div>

                    {instance.status !== 'exited' && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmKillId(instance.id);
                          setDeleteWorktreeChecked(false);
                        }}
                        className="mt-0.5 shrink-0 rounded p-1 text-neutral-700 opacity-0 transition-all hover:text-rose-300 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  {/* Active agents for this instance */}
                  {agents.length > 0 && (
                    <div className="mt-1.5 flex flex-col gap-1 border-l border-blue-500/20 pl-2.5 ml-0.5">
                      {agents.map(agent => (
                        <div key={agent.taskId} className="flex items-center gap-1.5 text-[10px]">
                          {agent.status === 'failed' ? (
                            <X className="h-2.5 w-2.5 shrink-0 text-rose-400/70" />
                          ) : (
                            <Loader className="h-2.5 w-2.5 shrink-0 animate-spin text-blue-300/60" />
                          )}
                          <span className={`truncate ${agent.status === 'failed' ? 'text-rose-400/50' : 'text-blue-300/50'}`}>
                            {agent.description}
                          </span>
                          {agent.status === 'failed' && (
                            <span className="shrink-0 text-rose-500/40">failed</span>
                          )}
                          {agent.status !== 'failed' && agent.lastToolName && (
                            <span className="shrink-0 text-neutral-700">
                              → {agent.lastToolName}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* History panel — resizable from top */}
      {filteredHistory.length > 0 && (
        <>
          {/* Resize handle */}
          <div
            onMouseDown={onResizeStart}
            className="group relative h-0 shrink-0 cursor-row-resize"
          >
            <div className="absolute inset-x-0 -top-1.5 -bottom-1.5" />
            <div className="absolute inset-x-0 top-0 h-px bg-neutral-800/40 transition-colors group-hover:bg-blue-500/50 group-active:bg-blue-500" />
          </div>

          {/* History header */}
          <div className="flex shrink-0 items-center gap-2 px-4 py-2">
            <Clock className="h-3 w-3 text-neutral-600" />
            <span className="text-[11px] font-medium text-neutral-600">History</span>
            <span className="ml-auto text-[10px] text-neutral-700">{filteredHistory.length}</span>
          </div>

          {/* History list */}
          <div className="shrink-0 overflow-y-auto px-2 pb-2" style={{ height: `${historyHeight}px` }}>
            <div className="flex flex-col gap-px">
              {filteredHistory.map(task => {
                const label = task.taskDescription || task.projectName;
                const canResume = !!task.worktreePath && task.worktreeExists === true;

                return (
                  <div
                    key={task.id}
                    className="group flex items-start gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-neutral-800/20"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] leading-tight text-neutral-600">
                        {label}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-700">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-700" />
                        {task.projectName}
                        {(task.totalInputTokens > 0 || task.totalCostUsd > 0) && (
                          <span className="ml-1">
                            {task.totalInputTokens > 0 && formatTokens(task.totalInputTokens + task.totalOutputTokens)}
                            {task.totalCostUsd > 0 && ` · $${task.totalCostUsd.toFixed(4)}`}
                          </span>
                        )}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100">
                      {canResume && (
                        <button
                          onClick={() => onResumeTask(task.id)}
                          className="rounded p-1 text-neutral-600 hover:text-emerald-300"
                          title="Resume in worktree"
                        >
                          <Play className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        onClick={() => onRemoveTask(task.id)}
                        className="rounded p-1 text-neutral-600 hover:text-rose-300"
                        title="Remove from history"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Kill confirmation modal */}
      {confirmKillId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setConfirmKillId(null)}
        >
          <div
            className="mx-4 w-full max-w-lg overflow-hidden rounded-xl border border-[#1e1e1e] bg-[#111111] shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="border-b border-[#1e1e1e] px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-500/10">
                  <Trash2 className="h-4 w-4 text-gray-400" />
                </div>
                <div>
                  <span className="block text-[14px] font-medium text-neutral-200">Kill Task</span>
                  <span className="block text-[12px] text-neutral-600">{killTarget?.projectName}</span>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="px-5 py-4">
              <p className="text-[13px] text-neutral-400">
                This will terminate the running Claude instance.
              </p>
              {hasWorktree && (
                <label className="mt-3 flex items-center gap-2.5 rounded-lg bg-[#0d0d0d] px-3 py-2.5 text-[12px] text-neutral-500">
                  <input
                    type="checkbox"
                    checked={deleteWorktreeChecked}
                    onChange={e => setDeleteWorktreeChecked(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[#2a2a2a] bg-[#0d0d0d] accent-red-500"
                  />
                  Also delete worktree and branch
                </label>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-[#1e1e1e] px-5 py-3">
              <button
                onClick={() => setConfirmKillId(null)}
                className="rounded-lg px-4 py-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-300"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onKill(confirmKillId, hasWorktree ? deleteWorktreeChecked : undefined);
                  setConfirmKillId(null);
                }}
                className="rounded-lg bg-red-600/80 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-red-500/80"
              >
                Kill
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}
