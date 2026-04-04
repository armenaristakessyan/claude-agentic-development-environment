import { useState } from 'react';
import { Trash2, Terminal } from 'lucide-react';
import type { Instance, InstanceStatus } from '../types';

interface InstanceListProps {
  instances: Instance[];
  selectedId: string | null;
  queuedIds: Set<string>;
  onSelect: (id: string) => void;
  onKill: (id: string, deleteWorktree?: boolean) => void;
}

const STATUS_COLORS: Record<InstanceStatus, string> = {
  processing: 'bg-blue-500 animate-pulse',
  waiting_input: 'bg-green-500',
  idle: 'bg-neutral-500',
  exited: 'bg-red-500',
};

export default function InstanceList({ instances, selectedId, queuedIds, onSelect, onKill }: InstanceListProps) {
  const queuedArray = instances
    .filter(i => queuedIds.has(i.id))
    .map(i => i.id);
  const [confirmKillId, setConfirmKillId] = useState<string | null>(null);
  const [deleteWorktreeChecked, setDeleteWorktreeChecked] = useState(false);

  const sorted = [...instances].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  if (sorted.length === 0) return null;

  const killTarget = instances.find(i => i.id === confirmKillId);
  const hasWorktree = killTarget?.worktreePath !== null && killTarget?.worktreePath !== undefined;

  return (
    <div className="flex flex-col gap-px">
      {sorted.map(instance => {
        const isSelected = instance.id === selectedId;

        return (
          <button
            key={instance.id}
            onClick={() => onSelect(instance.id)}
            className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
              isSelected
                ? 'bg-blue-500/10'
                : 'hover:bg-neutral-800/30'
            }`}
          >
            <div className="relative shrink-0">
              <Terminal className="h-3.5 w-3.5 text-neutral-500" />
              <span
                className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${STATUS_COLORS[instance.status]}`}
              />
            </div>

            <div className="min-w-0 flex-1">
              <span className={`block truncate text-[13px] ${isSelected ? 'text-neutral-200' : 'text-neutral-400'}`}>
                {instance.projectName}
              </span>
              {instance.taskDescription && (
                <span className="block truncate text-[11px] text-neutral-600">
                  {instance.taskDescription}
                </span>
              )}
            </div>

            {instance.status !== 'exited' && (
              <button
                onClick={e => {
                  e.stopPropagation();
                  setConfirmKillId(instance.id);
                  setDeleteWorktreeChecked(false);
                }}
                className="shrink-0 rounded p-1 text-neutral-600 opacity-0 transition-all hover:text-red-400 group-hover:opacity-100"
                title="Kill instance"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </button>
        );
      })}

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
    </div>
  );
}
