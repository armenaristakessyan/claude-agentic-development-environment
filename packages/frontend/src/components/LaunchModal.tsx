import { useState, useEffect, useRef } from 'react';
import { Play, X } from 'lucide-react';
import type { Project } from '../types';

interface LaunchModalProps {
  project: Project;
  onLaunch: (projectPath: string, taskDescription?: string) => void;
  onClose: () => void;
}

export default function LaunchModal({ project, onLaunch, onClose }: LaunchModalProps) {
  const [taskDescription, setTaskDescription] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isGit = project.gitBranch !== null;

  const handleSubmit = () => {
    const desc = taskDescription.trim();
    onLaunch(project.path, desc || undefined);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-neutral-200">
            <Play className="h-4 w-4 text-green-400" />
            <span className="text-sm font-semibold">Launch new space</span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3">
          <input
            ref={inputRef}
            type="text"
            value={taskDescription}
            onChange={e => setTaskDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What would you like to work on?"
            className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-500 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
          />
          <p className="mt-1.5 text-[11px] text-neutral-500">
            {isGit
              ? 'A worktree + branch will be created'
              : 'Not a git project — will launch directly'}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
