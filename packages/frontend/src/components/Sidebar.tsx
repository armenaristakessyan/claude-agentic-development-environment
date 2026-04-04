import { RefreshCw, FolderPlus, FolderOpen, GitBranch, FileDiff, Store } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import ProjectList from './ProjectList';
import MarketplacePanel from './MarketplacePanel';
import type { Project, Instance } from '../types';

export interface GitChange {
  status: string;
  path: string;
}

interface SidebarProps {
  projects: Project[];
  projectsLoading: boolean;
  projectsRefreshing: boolean;
  instances: Instance[];
  scanPaths: string[];
  onRefreshProjects: () => void;
  onLaunchProject: (projectPath: string, taskDescription?: string) => void;
  onDeleteWorktree: (projectPath: string, worktreePath: string) => void;
  onOpenScanPaths: () => void;
  onOpenTaskChanges?: (instanceId: string) => void;
  width: number;
  collapsed: boolean;
  onExpand: () => void;
}

function shortenPath(fullPath: string): string {
  const home = fullPath.replace(/^\/Users\/[^/]+/, '~');
  return home;
}

export default function Sidebar({
  projects,
  projectsLoading,
  projectsRefreshing,
  instances,
  scanPaths,
  onRefreshProjects,
  onLaunchProject,
  onDeleteWorktree,
  onOpenScanPaths,
  onOpenTaskChanges,
  width,
  collapsed,
  onExpand,
}: SidebarProps) {
  const [selectedRoot, setSelectedRoot] = useState<string | null>(scanPaths[0] ?? null);
  const [tab, setTab] = useState<'files' | 'changes' | 'marketplace'>('files');

  // Collapsed: thin icon strip
  if (collapsed) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col items-center rounded-xl bg-[#161616] pt-2 gap-1">
        <button
          onClick={() => { onExpand(); setTab('files'); }}
          className={`rounded p-2 transition-colors hover:bg-neutral-800/30 hover:text-neutral-400 ${tab === 'files' ? 'text-neutral-400' : 'text-neutral-600'}`}
          title="Projects"
        >
          <FolderOpen className="h-4 w-4" />
        </button>
        <button
          onClick={() => { onExpand(); setTab('changes'); }}
          className={`rounded p-2 transition-colors hover:bg-neutral-800/30 hover:text-neutral-400 ${tab === 'changes' ? 'text-neutral-400' : 'text-neutral-600'}`}
          title="Source Control"
        >
          <GitBranch className="h-4 w-4" />
        </button>
        <button
          onClick={() => { onExpand(); setTab('marketplace'); }}
          className={`rounded p-2 transition-colors hover:bg-neutral-800/30 hover:text-neutral-400 ${tab === 'marketplace' ? 'text-neutral-400' : 'text-neutral-600'}`}
          title="Marketplace"
        >
          <Store className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  // Expanded: full sidebar
  return (
    <aside className="flex h-full shrink-0 flex-col rounded-xl bg-[#161616]" style={{ width: `${width}px` }}>
      {/* Tab bar */}
      <div className="flex h-10 items-center gap-0.5 px-2">
        <button
          onClick={() => setTab('files')}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            tab === 'files' ? 'text-neutral-300' : 'text-neutral-600 hover:text-neutral-400'
          }`}
          title="Projects"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          {tab === 'files' && <span>Projects</span>}
        </button>
        <button
          onClick={() => setTab('changes')}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            tab === 'changes' ? 'text-neutral-300' : 'text-neutral-600 hover:text-neutral-400'
          }`}
          title="Changes"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          {tab === 'changes' && <span>Changes</span>}
        </button>
        <button
          onClick={() => setTab('marketplace')}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            tab === 'marketplace' ? 'text-neutral-300' : 'text-neutral-600 hover:text-neutral-400'
          }`}
          title="Marketplace"
        >
          <Store className="h-3.5 w-3.5 shrink-0" />
          {tab === 'marketplace' && <span>Marketplace</span>}
        </button>

        <div className="flex-1" />

        {tab === 'files' && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={onOpenScanPaths}
              className="rounded p-1.5 text-neutral-600 transition-colors hover:text-neutral-400"
              title="Add folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onRefreshProjects}
              className="rounded p-1.5 text-neutral-600 transition-colors hover:text-neutral-400"
              title="Refresh projects"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${projectsRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      {tab === 'files' ? (
        <div className="flex-1 overflow-y-auto px-2 pt-2">
          {scanPaths.length > 0 && (
            <div className="mb-2 px-1">
              <select
                value={selectedRoot ?? '__all__'}
                onChange={e => setSelectedRoot(e.target.value === '__all__' ? null : e.target.value)}
                className="w-full cursor-pointer rounded border-0 bg-transparent px-0 py-1 text-[12px] text-neutral-500 outline-none"
              >
                {scanPaths.length > 1 && (
                  <option value="__all__">All roots</option>
                )}
                {scanPaths.map(p => (
                  <option key={p} value={p}>{shortenPath(p)}</option>
                ))}
              </select>
            </div>
          )}
          <ProjectList
            projects={projects}
            instances={instances}
            loading={projectsLoading}
            scanPaths={scanPaths}
            selectedRoot={selectedRoot}
            onLaunch={onLaunchProject}
            onDeleteWorktree={onDeleteWorktree}
          />
        </div>
      ) : tab === 'changes' ? (
        <GitChangesPanel instances={instances} onOpenTaskChanges={onOpenTaskChanges} />
      ) : (
        <MarketplacePanel />
      )}
    </aside>
  );
}

// --- Git Changes Panel ---

function GitChangesPanel({ instances, onOpenTaskChanges }: { instances: Instance[]; onOpenTaskChanges?: (instanceId: string) => void }) {
  const [changes, setChanges] = useState<Record<string, GitChange[]>>({});
  const [loading, setLoading] = useState(false);

  const activeInstances = instances.filter(i => i.status !== 'exited');

  const fetchChanges = useCallback(async () => {
    setLoading(true);
    const result: Record<string, GitChange[]> = {};
    for (const inst of activeInstances) {
      try {
        const res = await fetch(`/api/instances/${inst.id}/context/changes`);
        if (res.ok) {
          const data = await res.json() as { files: GitChange[] };
          if (data.files.length > 0) {
            result[inst.id] = data.files;
          }
        }
      } catch { /* skip */ }
    }
    setChanges(result);
    setLoading(false);
  }, [activeInstances.map(i => i.id).join(',')]);

  useEffect(() => {
    fetchChanges();
    const interval = setInterval(fetchChanges, 10000);
    return () => clearInterval(interval);
  }, [fetchChanges]);

  const statusLabel = (s: string) => {
    if (s === 'M') return 'Modified';
    if (s === 'A') return 'Added';
    if (s === '??') return 'Untracked';
    if (s === 'D') return 'Deleted';
    if (s === 'R') return 'Renamed';
    return s;
  };

  const totalChanges = Object.values(changes).reduce((sum, files) => sum + files.length, 0);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Summary */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] text-neutral-600">
          {totalChanges > 0 ? `${totalChanges} changed file${totalChanges !== 1 ? 's' : ''}` : 'No changes'}
        </span>
        <button
          onClick={fetchChanges}
          className="rounded p-1 text-neutral-600 transition-colors hover:text-neutral-400"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Change list */}
      <div className="flex-1 overflow-y-auto px-2">
        {activeInstances.length === 0 && (
          <p className="py-6 text-center text-[12px] text-neutral-700">No active tasks</p>
        )}
        {activeInstances.map(inst => {
          const files = changes[inst.id];
          if (!files || files.length === 0) return null;
          const label = inst.taskDescription || inst.projectName;
          return (
            <div key={inst.id} className="mb-3">
              <div className="mb-1 truncate px-1 text-[11px] font-medium text-neutral-600">
                {label}
              </div>
              {files.map(file => (
                <button
                  key={file.path}
                  onClick={() => onOpenTaskChanges?.(inst.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-[#1a1a1a]"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    file.status === 'M' ? 'bg-amber-400' :
                    file.status === 'A' || file.status === '??' ? 'bg-green-400' :
                    file.status === 'D' ? 'bg-red-400' : 'bg-neutral-500'
                  }`} />
                  <FileDiff className="h-3 w-3 shrink-0 text-neutral-600" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-400">
                    {file.path.split('/').pop()}
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-700">
                    {statusLabel(file.status)}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

