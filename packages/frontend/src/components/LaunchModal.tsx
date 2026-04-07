import { useState, useEffect, useRef } from 'react';
import { Rocket, X, GitBranch, Folder, Plus } from 'lucide-react';
import type { Project } from '../types';

/** Slugify a task description into a branch-friendly name */
function slugify(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 4).join(' ');
  return words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

interface LaunchModalProps {
  project: Project;
  onLaunch: (projectPath: string, taskDescription?: string, branchName?: string) => void;
  onClose: () => void;
}

export default function LaunchModal({ project, onLaunch, onClose }: LaunchModalProps) {
  const [taskDescription, setTaskDescription] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-fill branch name from task description (unless user edited it manually)
  useEffect(() => {
    if (!branchTouched && taskDescription.trim()) {
      setBranchName(`claude/${slugify(taskDescription)}`);
    } else if (!branchTouched && !taskDescription.trim()) {
      setBranchName('');
    }
  }, [taskDescription, branchTouched]);

  const isGit = project.gitBranch !== null;

  const handleSubmit = () => {
    const desc = taskDescription.trim();
    const branch = branchName.trim() || undefined;
    onLaunch(project.path, desc || undefined, isGit && desc ? branch : undefined);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-lg overflow-hidden rounded-xl border border-border-default bg-modal shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-default px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-500/10">
              <Plus className="h-4 w-4 text-gray-400" />
            </div>
            <div>
              <span className="block text-[14px] font-medium text-primary">New Task</span>
              <span className="block text-[12px] text-faint">{project.name}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-faint transition-colors hover:bg-elevated hover:text-tertiary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {/* Project info badge */}
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-root px-3 py-2 text-[12px] text-muted">
            {isGit ? (
              <>
                <GitBranch className="h-3 w-3 text-faint" />
                <span>{project.gitBranch}</span>
                <span className="text-faint">--</span>
                <span className="text-faint">worktree + branch will be created</span>
              </>
            ) : (
              <>
                <Folder className="h-3 w-3 text-faint" />
                <span className="text-faint">Not a git project -- will launch directly</span>
              </>
            )}
          </div>

          {/* Task input */}
          <textarea
            ref={inputRef}
            value={taskDescription}
            onChange={e => setTaskDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What would you like to work on?"
            rows={3}
            className="w-full resize-none rounded-lg border border-border-input bg-root px-3 py-2.5 text-[14px] text-secondary placeholder-placeholder outline-none transition-colors focus:border-border-focus"
          />

          {/* Branch name — only for git projects with a task description */}
          {isGit && taskDescription.trim() && (
            <div className="mt-3">
              <label className="mb-1 flex items-center gap-1.5 text-[11px] text-faint">
                <GitBranch className="h-3 w-3" />
                Branch name
              </label>
              <input
                type="text"
                value={branchName}
                onChange={e => { setBranchName(e.target.value); setBranchTouched(true); }}
                onKeyDown={handleKeyDown}
                placeholder="claude/my-feature"
                className="w-full rounded-lg border border-border-input bg-root px-3 py-2 font-mono text-[13px] text-tertiary placeholder-placeholder outline-none transition-colors focus:border-border-focus"
              />
            </div>
          )}

          <p className="mt-2 text-[11px] text-faint">
            Enter to launch -- Shift+Enter for new line -- Esc to cancel
          </p>
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
            onClick={handleSubmit}
            className="flex items-center gap-2 rounded-lg bg-green-600/80 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-green-500/80"
          >
            <Rocket className="h-3.5 w-3.5" />
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
