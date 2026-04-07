import { useState } from 'react';
import { Zap, X, Loader, ChevronDown, ChevronUp, PowerOff } from 'lucide-react';
import type { RtkStatus, RtkStats } from '../types';

interface RtkStatusIndicatorProps {
  status: RtkStatus | null;
  stats: RtkStats | null;
  loading: boolean;
  installing: boolean;
  dismissed: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onDismiss: () => void;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function RtkStatusIndicator({
  status,
  stats,
  loading,
  installing,
  dismissed,
  onInstall,
  onUninstall,
  onDismiss,
}: RtkStatusIndicatorProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading) return null;
  if (!status?.installed) return null;

  // RTK installed but hooks not configured
  if (!status.hooksInstalled) {
    if (dismissed) {
      return (
        <button
          onClick={onInstall}
          className="flex items-center gap-1 rounded-md bg-elevated/40 px-2 py-0.5 text-[11px] text-faint transition-colors hover:text-tertiary"
          title="RTK available — click to enable token compression"
        >
          <Zap className="h-3 w-3" />
          RTK
        </button>
      );
    }

    return (
      <span className="flex items-center gap-1.5 rounded-md bg-amber-950/30 px-2.5 py-0.5 text-[11px] text-amber-400/80">
        <Zap className="h-3 w-3" />
        RTK detected
        <span className="text-amber-500/50">·</span>
        <button
          onClick={onInstall}
          disabled={installing}
          className="font-medium text-amber-300/90 transition-colors hover:text-amber-200 disabled:opacity-50"
        >
          {installing ? (
            <span className="flex items-center gap-1">
              <Loader className="h-2.5 w-2.5 animate-spin" />
              Enabling...
            </span>
          ) : (
            'Enable token compression'
          )}
        </button>
        <button
          onClick={onDismiss}
          className="ml-1 text-amber-600/50 transition-colors hover:text-amber-400/80"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }

  // RTK active — show savings indicator
  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 rounded-md bg-green-950/25 px-2 py-0.5 text-[11px] text-green-400/80 transition-colors hover:bg-green-950/40"
      >
        <Zap className="h-3 w-3" />
        RTK
        {stats && stats.savingsPercent > 0 && (
          <span className="text-green-500/60">
            {stats.savingsPercent}% saved
          </span>
        )}
        {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
      </button>

      {expanded && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setExpanded(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border-default bg-modal p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-secondary">RTK Token Compression</span>
              <span className="rounded bg-green-950/40 px-1.5 py-0.5 text-[10px] text-green-400">Active</span>
            </div>

            {status.version && (
              <p className="mb-2 text-[11px] text-faint">{status.version}</p>
            )}

            {stats ? (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Tokens saved</span>
                  <span className="text-green-400/80">{formatTokenCount(stats.totalTokensSaved)}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Original tokens</span>
                  <span className="text-tertiary">{formatTokenCount(stats.totalTokensOriginal)}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Savings</span>
                  <span className="font-medium text-green-400">{stats.savingsPercent}%</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Commands optimized</span>
                  <span className="text-tertiary">{stats.commandCount}</span>
                </div>
                <div className="mt-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                    <div
                      className="h-full rounded-full bg-green-500/60 transition-all"
                      style={{ width: `${Math.min(100, stats.savingsPercent)}%` }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-faint">No savings data yet. Stats appear after RTK processes commands.</p>
            )}

            <div className="mt-3 border-t border-border-default pt-2">
              <button
                onClick={() => { onUninstall(); setExpanded(false); }}
                className="flex items-center gap-1.5 text-[11px] text-faint transition-colors hover:text-red-400"
              >
                <PowerOff className="h-3 w-3" />
                Disable RTK hooks
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
