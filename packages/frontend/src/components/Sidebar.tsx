import { RefreshCw, FolderOpen, Zap, ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { useState } from 'react';
import ProjectList from './ProjectList';
import InstanceList from './InstanceList';
import type { Project, Instance } from '../types';

interface SidebarProps {
  projects: Project[];
  projectsLoading: boolean;
  projectsRefreshing: boolean;
  instances: Instance[];
  selectedInstanceId: string | null;
  scanPaths: string[];
  queuedIds: Set<string>;
  onRefreshProjects: () => void;
  onLaunchProject: (projectPath: string, taskDescription?: string) => void;
  onSelectInstance: (id: string) => void;
  onKillInstance: (id: string, deleteWorktree?: boolean) => void;
  onDeleteWorktree: (projectPath: string, worktreePath: string) => void;
  onOpenScanPaths: () => void;
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
  selectedInstanceId,
  scanPaths,
  queuedIds,
  onRefreshProjects,
  onLaunchProject,
  onSelectInstance,
  onKillInstance,
  onDeleteWorktree,
  onOpenScanPaths,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [instancesOpen, setInstancesOpen] = useState(true);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(scanPaths[0] ?? null);

  const activeInstances = instances.filter(i => i.status !== 'exited');
  const waitingCount = instances.filter(i => i.status === 'waiting_input').length;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-neutral-800 bg-[#0f0f0f]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-orange-500 to-amber-600">
          <Zap className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-semibold text-neutral-200">Claude Dashboard</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Instances section */}
        <div className="border-b border-neutral-800/50">
          <button
            onClick={() => setInstancesOpen(!instancesOpen)}
            className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 transition-colors hover:text-neutral-300"
          >
            {instancesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>Instances</span>
            {activeInstances.length > 0 && (
              <span className="ml-auto rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
                {activeInstances.length}
              </span>
            )}
            {waitingCount > 0 && (
              <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                {waitingCount}
              </span>
            )}
          </button>

          {instancesOpen && (
            <div className="px-2 pb-2">
              <InstanceList
                instances={instances}
                selectedId={selectedInstanceId}
                queuedIds={queuedIds}
                onSelect={onSelectInstance}
                onKill={onKillInstance}
              />
            </div>
          )}
        </div>

        {/* Projects section */}
        <div>
          <div className="flex items-center">
            <button
              onClick={() => setProjectsOpen(!projectsOpen)}
              className="flex flex-1 items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 transition-colors hover:text-neutral-300"
            >
              {projectsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <FolderOpen className="h-3 w-3" />
              <span>Projects</span>
              <span className="ml-auto rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
                {projects.length}
              </span>
            </button>
            <button
              onClick={onOpenScanPaths}
              className="rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
              title="Scan paths settings"
            >
              <Settings className="h-3 w-3" />
            </button>
            <button
              onClick={onRefreshProjects}
              className="mr-2 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
              title="Refresh projects"
            >
              <RefreshCw className={`h-3 w-3 ${projectsRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {projectsOpen && (
            <div className="px-2 pb-2">
              {/* Root selector */}
              {scanPaths.length > 0 && (
                <div className="mb-1.5">
                  <select
                    value={selectedRoot ?? '__all__'}
                    onChange={e => setSelectedRoot(e.target.value === '__all__' ? null : e.target.value)}
                    className="w-full cursor-pointer rounded-md border border-neutral-800 bg-neutral-900/50 px-2 py-1.5 text-[11px] text-neutral-400 outline-none transition-colors focus:border-neutral-600 focus:ring-1 focus:ring-neutral-600"
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
          )}
        </div>
      </div>
    </aside>
  );
}
