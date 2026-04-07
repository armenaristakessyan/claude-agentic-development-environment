import { Check, Download, Loader, Puzzle } from 'lucide-react';
import type { PluginMetadata } from '../types';

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function marketplaceLabel(marketplace: string): string {
  if (marketplace === 'claude-plugins-official') return 'Official';
  if (marketplace === 'shared-claude-marketplace-lib') return 'Agicap';
  return marketplace;
}

interface PluginCardProps {
  plugin: PluginMetadata;
  isLoading?: boolean;
  onClick: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

export default function PluginCard({ plugin, isLoading, onClick, onInstall, onUninstall }: PluginCardProps) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full flex-col gap-1.5 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-[#1e1e1e] hover:bg-[#111111]"
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[#1a1a1a]">
          <Puzzle className="h-3.5 w-3.5 text-neutral-500" />
        </div>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-200">
          {plugin.name}
        </span>
        {plugin.version && (
          <span className="shrink-0 text-[10px] text-neutral-600">v{plugin.version}</span>
        )}
      </div>

      {/* Description */}
      <p className="line-clamp-2 text-[11px] leading-relaxed text-neutral-500">
        {plugin.description || 'No description'}
      </p>

      {/* Footer */}
      <div className="flex items-center gap-1.5">
        {/* Segment tag */}
        {plugin.segment && (
          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-300">
            {plugin.segment}
          </span>
        )}

        {/* Marketplace badge */}
        <span className="rounded bg-neutral-800/50 px-1.5 py-0.5 text-[10px] text-neutral-500">
          {marketplaceLabel(plugin.marketplace)}
        </span>

        {/* Skills count */}
        <span className="text-[10px] text-neutral-600">
          {plugin.skillCount} skill{plugin.skillCount !== 1 ? 's' : ''}
        </span>

        {/* Install count */}
        {plugin.installCount != null && plugin.installCount > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-neutral-600">
            <Download className="h-2.5 w-2.5" />
            {formatCount(plugin.installCount)}
          </span>
        )}

        <div className="flex-1" />

        {/* Install/Uninstall button */}
        {isLoading ? (
          <span className="flex items-center gap-1 rounded bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300">
            <Loader className="h-2.5 w-2.5 animate-spin" />
            {plugin.isInstalled ? 'Installing...' : 'Removing...'}
          </span>
        ) : plugin.isInstalled ? (
          <span
            onClick={e => { e.stopPropagation(); onUninstall(); }}
            className="flex items-center gap-1 rounded bg-green-500/10 px-2 py-0.5 text-[10px] text-emerald-300 transition-colors hover:bg-red-500/10 hover:text-rose-300"
            title="Click to uninstall"
          >
            <Check className="h-2.5 w-2.5" />
            Installed
          </span>
        ) : (
          <span
            onClick={e => { e.stopPropagation(); onInstall(); }}
            className="rounded bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300 opacity-0 transition-all group-hover:opacity-100 hover:bg-blue-500/20"
          >
            Install
          </span>
        )}
      </div>
    </button>
  );
}
