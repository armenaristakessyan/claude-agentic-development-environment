import { RefreshCw, FolderPlus, FolderOpen, GitBranch, FileDiff, Store, Shield, ChevronDown, ChevronRight, Loader } from 'lucide-react';
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
  selectedInstanceId?: string | null;
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
  selectedInstanceId,
  width,
  collapsed,
  onExpand,
}: SidebarProps) {
  const [selectedRoot, setSelectedRoot] = useState<string | null>(scanPaths[0] ?? null);
  const [tab, setTab] = useState<'files' | 'changes' | 'marketplace'>('files');
  const [showPermissions, setShowPermissions] = useState(false);

  // Collapsed: thin icon strip
  if (collapsed) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col items-center rounded-xl bg-surface pt-2 gap-1">
        <button
          onClick={() => { onExpand(); setTab('files'); }}
          className={`rounded p-2 transition-colors hover:bg-elevated/30 hover:text-tertiary ${tab === 'files' ? 'text-tertiary' : 'text-faint'}`}
          title="Projects"
        >
          <FolderOpen className="h-4 w-4" />
        </button>
        <button
          onClick={() => { onExpand(); setTab('changes'); }}
          className={`rounded p-2 transition-colors hover:bg-elevated/30 hover:text-tertiary ${tab === 'changes' ? 'text-tertiary' : 'text-faint'}`}
          title="Source Control"
        >
          <GitBranch className="h-4 w-4" />
        </button>
        <button
          onClick={() => { onExpand(); setTab('marketplace'); }}
          className={`rounded p-2 transition-colors hover:bg-elevated/30 hover:text-tertiary ${tab === 'marketplace' ? 'text-tertiary' : 'text-faint'}`}
          title="Marketplace"
        >
          <Store className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => { onExpand(); setShowPermissions(true); }}
          className="rounded p-2 text-faint transition-colors hover:bg-elevated/30 hover:text-tertiary"
          title="Permissions"
        >
          <Shield className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  // Expanded: full sidebar
  return (
    <aside className="flex h-full shrink-0 flex-col rounded-xl bg-surface" style={{ width: `${width}px` }}>
      {/* Tab bar */}
      <div className="flex h-10 items-center gap-0.5 px-2">
        <button
          onClick={() => setTab('files')}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            tab === 'files' ? 'text-secondary' : 'text-faint hover:text-tertiary'
          }`}
          title="Projects"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          {tab === 'files' && <span>Projects</span>}
        </button>
        <button
          onClick={() => setTab('changes')}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            tab === 'changes' ? 'text-secondary' : 'text-faint hover:text-tertiary'
          }`}
          title="Changes"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          {tab === 'changes' && <span>Changes</span>}
        </button>
        <button
          onClick={() => setTab('marketplace')}
          className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            tab === 'marketplace' ? 'text-secondary' : 'text-faint hover:text-tertiary'
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
              className="rounded p-1.5 text-faint transition-colors hover:text-tertiary"
              title="Add folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onRefreshProjects}
              className="rounded p-1.5 text-faint transition-colors hover:text-tertiary"
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
                className="w-full cursor-pointer rounded border-0 bg-transparent px-0 py-1 text-[12px] text-muted outline-none"
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

      {/* Permissions panel (slides up from bottom) */}
      {showPermissions && (
        <PermissionsPanel
          instanceId={selectedInstanceId}
          onClose={() => setShowPermissions(false)}
        />
      )}

      {/* Settings button at bottom */}
      {!showPermissions && (
        <div className="shrink-0 border-t border-border-default px-3 py-2">
          <button
            onClick={() => setShowPermissions(true)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-faint transition-colors hover:bg-hover hover:text-tertiary"
          >
            <Shield className="h-3.5 w-3.5" />
            <span>Permissions</span>
          </button>
        </div>
      )}
    </aside>
  );
}

// --- Permissions Panel ---

interface PermissionsByScope {
  session: string[];
  project: string[];
  projectShared: string[];
  user: string[];
  global: string[];
}

const SCOPE_META = [
  { key: 'session', label: 'Session', description: 'Current session only', color: 'text-blue-300', bgColor: 'bg-blue-400/10' },
  { key: 'project', label: 'Project (local)', description: '.claude/settings.local.json', color: 'text-emerald-300', bgColor: 'bg-green-400/10' },
  { key: 'projectShared', label: 'Project (shared)', description: '.claude/settings.json', color: 'text-amber-300', bgColor: 'bg-amber-400/10' },
  { key: 'user', label: 'User', description: '~/.claude/settings.local.json', color: 'text-violet-300', bgColor: 'bg-purple-400/10' },
  { key: 'global', label: 'Global', description: '~/.claude/settings.json', color: 'text-orange-300/80', bgColor: 'bg-orange-400/10' },
] as const;

function PermissionsPanel({ instanceId, onClose }: { instanceId?: string | null; onClose: () => void }) {
  const [permissions, setPermissions] = useState<PermissionsByScope | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(new Set(['session', 'project']));

  useEffect(() => {
    if (!instanceId) {
      setPermissions(null);
      return;
    }
    setLoading(true);
    fetch(`/api/instances/${instanceId}/permissions`)
      .then(res => res.ok ? res.json() as Promise<PermissionsByScope> : null)
      .then(data => { setPermissions(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [instanceId]);

  const toggleScope = (key: string) => {
    setExpandedScopes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const totalPermissions = permissions
    ? Object.values(permissions).reduce((sum, arr) => sum + arr.length, 0)
    : 0;

  return (
    <div className="shrink-0 border-t border-border-default">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Shield className="h-3.5 w-3.5 text-muted" />
        <span className="text-[12px] font-medium text-tertiary">Permissions</span>
        <span className="text-[10px] text-faint">{totalPermissions} rule{totalPermissions !== 1 ? 's' : ''}</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="text-[11px] text-faint hover:text-tertiary"
        >
          Hide
        </button>
      </div>

      {/* Content */}
      <div className="max-h-[300px] overflow-y-auto px-2 pb-2">
        {!instanceId ? (
          <p className="px-2 py-3 text-[11px] text-faint">Select a task to view permissions</p>
        ) : loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader className="h-3.5 w-3.5 animate-spin text-faint" />
          </div>
        ) : !permissions ? (
          <p className="px-2 py-3 text-[11px] text-faint">Failed to load permissions</p>
        ) : (
          SCOPE_META.map(scope => {
            const rules = permissions[scope.key as keyof PermissionsByScope];
            const isExpanded = expandedScopes.has(scope.key);
            return (
              <div key={scope.key} className="mb-1">
                <button
                  onClick={() => toggleScope(scope.key)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  {isExpanded
                    ? <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
                    : <ChevronRight className="h-3 w-3 shrink-0 text-faint" />
                  }
                  <span className={`text-[11px] font-medium ${scope.color}`}>{scope.label}</span>
                  <span className="text-[10px] text-faint">{rules.length}</span>
                </button>
                {isExpanded && rules.length > 0 && (
                  <div className="ml-5 space-y-0.5 pb-1">
                    {rules.map((rule, i) => (
                      <div
                        key={i}
                        className={`rounded px-2 py-1 text-[11px] font-mono ${scope.bgColor} ${scope.color}`}
                      >
                        {rule}
                      </div>
                    ))}
                  </div>
                )}
                {isExpanded && rules.length === 0 && (
                  <p className="ml-5 pb-1 text-[10px] text-faint">No permissions</p>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
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
        <span className="text-[11px] text-faint">
          {totalChanges > 0 ? `${totalChanges} changed file${totalChanges !== 1 ? 's' : ''}` : 'No changes'}
        </span>
        <button
          onClick={fetchChanges}
          className="rounded p-1 text-faint transition-colors hover:text-tertiary"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Change list */}
      <div className="flex-1 overflow-y-auto px-2">
        {activeInstances.length === 0 && (
          <p className="py-6 text-center text-[12px] text-faint">No active tasks</p>
        )}
        {activeInstances.map(inst => {
          const files = changes[inst.id];
          if (!files || files.length === 0) return null;
          const label = inst.taskDescription || inst.projectName;
          return (
            <div key={inst.id} className="mb-3">
              <div className="mb-1 truncate px-1 text-[11px] font-medium text-faint">
                {label}
              </div>
              {files.map(file => (
                <button
                  key={file.path}
                  onClick={() => onOpenTaskChanges?.(inst.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-hover"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    file.status === 'M' ? 'bg-amber-400' :
                    file.status === 'A' || file.status === '??' ? 'bg-green-400' :
                    file.status === 'D' ? 'bg-red-400' : 'bg-neutral-500'
                  }`} />
                  <FileDiff className="h-3 w-3 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-tertiary">
                    {file.path.split('/').pop()}
                  </span>
                  <span className="shrink-0 text-[10px] text-faint">
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

