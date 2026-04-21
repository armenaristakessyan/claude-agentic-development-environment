import { BellRing, X } from 'lucide-react';
import type { AttentionQueueItem } from '../types';

interface AttentionQueueBannerProps {
  queue: AttentionQueueItem[];
  selectedInstanceId: string | null;
  onSkip: (id: string) => void;
  onJump: (id: string) => void;
}

export default function AttentionQueueBanner({
  queue,
  selectedInstanceId,
  onSkip,
  onJump,
}: AttentionQueueBannerProps) {
  if (queue.length === 0) return null;

  return (
    <div className="flex h-9 items-center gap-3 border-b border-border-default bg-hover px-4">
      <div className="flex shrink-0 items-center gap-1.5">
        <BellRing className="h-3.5 w-3.5 text-amber-400 light:text-amber-700" />
        <span className="text-xs font-medium text-amber-400 light:text-amber-700">
          {queue.length} waiting
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-0.5 py-1">
        {queue.map(item => {
          const isActive = item.instanceId === selectedInstanceId;
          return (
            <button
              key={item.instanceId}
              onClick={() => onJump(item.instanceId)}
              className={`group flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                isActive
                  ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40 light:bg-amber-100 light:text-amber-800 light:ring-amber-400'
                  : 'bg-elevated text-tertiary hover:bg-hover hover:text-secondary'
              }`}
            >
              <span className="max-w-[120px] truncate">{item.projectName}</span>
              <span
                role="button"
                onClick={e => {
                  e.stopPropagation();
                  onSkip(item.instanceId);
                }}
                className="ml-0.5 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-hover group-hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
