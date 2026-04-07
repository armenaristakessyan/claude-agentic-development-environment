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
        className="mx-4 w-full max-w-lg overflow-hidden rounded-xl border border-[#1e1e1e] bg-[#111111] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1e1e1e] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-500/10">
              <Plus className="h-4 w-4 text-gray-400" />
            </div>
            <div>
              <span className="block text-[14px] font-medium text-neutral-200">New Task</span>
              <span className="block text-[12px] text-neutral-600">{project.name}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-600 transition-colors hover:bg-[#1e1e1e] hover:text-neutral-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {/* Project info badge */}
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-[#0d0d0d] px-3 py-2 text-[12px] text-neutral-500">
            {isGit ? (
              <>
                <GitBranch className="h-3 w-3 text-neutral-600" />
                <span>{project.gitBranch}</span>
                <span className="text-neutral-700">--</span>
                <span className="text-neutral-600">worktree + branch will be created</span>
              </>
            ) : (
              <>
                <Folder className="h-3 w-3 text-neutral-600" />
                <span className="text-neutral-600">Not a git project -- will launch directly</span>
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
            className="w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5 text-[14px] text-neutral-300 placeholder-neutral-600 outline-none transition-colors focus:border-[#333]"
          />

          {/* Branch name — only for git projects with a task description */}
          {isGit && taskDescription.trim() && (
            <div className="mt-3">
              <label className="mb-1 flex items-center gap-1.5 text-[11px] text-neutral-600">
                <GitBranch className="h-3 w-3" />
                Branch name
              </label>
              <input
                type="text"
                value={branchName}
                onChange={e => { setBranchName(e.target.value); setBranchTouched(true); }}
                onKeyDown={handleKeyDown}
                placeholder="claude/my-feature"
                className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 font-mono text-[13px] text-neutral-400 placeholder-neutral-700 outline-none transition-colors focus:border-[#333]"
              />
            </div>
          )}

          <p className="mt-2 text-[11px] text-neutral-700">
            Enter to launch -- Shift+Enter for new line -- Esc to cancel
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[#1e1e1e] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-300"
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
