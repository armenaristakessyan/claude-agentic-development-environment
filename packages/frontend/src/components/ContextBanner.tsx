import { Target, GitBranch, MessageSquare } from 'lucide-react';

interface ContextBannerProps {
  taskDescription: string | null;
  branchName: string | null;
  lastUserPrompt: string | null;
}

function prettifyBranch(branch: string): string {
  // Strip common prefixes like "claude/", "claude-dashboard/"
  const stripped = branch.replace(/^(?:claude-dashboard|claude)\//, '');
  // Replace hyphens with spaces
  return stripped.replace(/-/g, ' ');
}

export default function ContextBanner({ taskDescription, branchName, lastUserPrompt }: ContextBannerProps) {
  // Use taskDescription first, fall back to prettified branchName for pre-existing worktrees
  const label = taskDescription ?? (branchName ? prettifyBranch(branchName) : null);

  if (!label && !lastUserPrompt) return null;

  const LabelIcon = taskDescription ? Target : GitBranch;

  return (
    <div className="flex gap-4 border-b border-border-default bg-popover px-4 py-2.5">
      {label && (
        <div className="flex shrink-0 items-start gap-2">
          <LabelIcon className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
          <span className="text-sm font-medium text-primary">{label}</span>
        </div>
      )}
      {label && lastUserPrompt && (
        <div className="shrink-0 self-stretch border-l border-border-default" />
      )}
      {lastUserPrompt && (
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-secondary line-clamp-5">
            {lastUserPrompt}
          </p>
        </div>
      )}
    </div>
  );
}
