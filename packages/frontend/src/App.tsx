import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Terminal } from 'lucide-react';
import Sidebar from './components/Sidebar';
import TerminalView from './components/TerminalView';
import AttentionQueueBanner from './components/AttentionQueueBanner';
import ContextBanner from './components/ContextBanner';
import ScanPathsModal from './components/ScanPathsModal';
import { useProjects } from './hooks/useProjects';
import { useInstances } from './hooks/useInstances';
import { useConfig } from './hooks/useConfig';
import { useAttentionQueue } from './hooks/useAttentionQueue';

export default function App() {
  const { config, updateConfig } = useConfig();
  const { projects, loading: projectsLoading, refreshing: projectsRefreshing, refreshProjects, deleteWorktree } = useProjects();
  const { instances, spawnInstance, killInstance } = useInstances();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [typingLocked, setTypingLocked] = useState(false);
  const [scanPathsOpen, setScanPathsOpen] = useState(false);
  const autoOpenedRef = useRef(false);

  const { queue, skipInstance, jumpToInstance } = useAttentionQueue({
    instances,
    selectedInstanceId,
    onSelectInstance: setSelectedInstanceId,
    typingLocked,
  });

  const queuedIds = useMemo(
    () => new Set(queue.map(q => q.instanceId)),
    [queue],
  );

  const handleLaunch = useCallback(async (projectPath: string, taskDescription?: string) => {
    try {
      const instance = await spawnInstance(projectPath, taskDescription);
      setSelectedInstanceId(instance.id);
      if (taskDescription) {
        // A worktree was created — refresh project list to show it
        refreshProjects();
      }
    } catch {
      // Error already logged in hook
    }
  }, [spawnInstance, refreshProjects]);

  const handleKill = useCallback(async (id: string, deleteWt?: boolean) => {
    await killInstance(id, deleteWt);
    if (selectedInstanceId === id) {
      setSelectedInstanceId(null);
    }
    if (deleteWt) {
      refreshProjects();
    }
  }, [killInstance, selectedInstanceId, refreshProjects]);

  const handleDeleteWorktree = useCallback(async (projectPath: string, worktreePath: string) => {
    await deleteWorktree(projectPath, worktreePath);
  }, [deleteWorktree]);

  const handleSkip = useCallback((id: string) => {
    setTypingLocked(false);
    skipInstance(id);
  }, [skipInstance]);

  const handleJump = useCallback((id: string) => {
    setTypingLocked(false);
    jumpToInstance(id);
  }, [jumpToInstance]);

  const handleTypingChange = useCallback((typing: boolean) => {
    setTypingLocked(typing);
  }, []);

  const handleSaveScanPaths = useCallback(async (paths: string[]) => {
    try {
      await updateConfig({ scanPaths: paths });
      refreshProjects();
      setScanPathsOpen(false);
    } catch {
      // Error already logged in hook
    }
  }, [updateConfig, refreshProjects]);

  useEffect(() => {
    if (!projectsLoading && projects.length === 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setScanPathsOpen(true);
    }
  }, [projectsLoading, projects.length]);

  const selectedInstance = instances.find(i => i.id === selectedInstanceId);

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <div className="flex items-center justify-between border-b border-neutral-800 bg-[#0f0f0f] px-4 py-2">
          <div className="flex items-center gap-2">
            {selectedInstance ? (
              <>
                <Terminal className="h-4 w-4 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-200">
                  {selectedInstance.projectName}
                </span>
                <span className="text-xs text-neutral-500">
                  {selectedInstance.id.slice(0, 8)}
                </span>
              </>
            ) : (
              <span className="text-sm text-neutral-500">No instance selected</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            {queue.length > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                {queue.length} queued
              </span>
            )}
            <span>{instances.filter(i => i.status !== 'exited').length} active</span>
          </div>
        </div>

        <AttentionQueueBanner
          queue={queue}
          selectedInstanceId={selectedInstanceId}
          onSkip={handleSkip}
          onJump={handleJump}
        />

        {selectedInstance && (
          <ContextBanner
            taskDescription={selectedInstance.taskDescription}
            branchName={selectedInstance.branchName}
            lastUserPrompt={selectedInstance.lastUserPrompt}
          />
        )}

        {/* Terminal area */}
        <div className="flex-1 overflow-hidden">
          {selectedInstance ? (
            <TerminalView
              key={selectedInstance.id}
              instanceId={selectedInstance.id}
              onTypingChange={handleTypingChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <Terminal className="mx-auto mb-4 h-12 w-12 text-neutral-700" />
                <p className="text-sm text-neutral-500">
                  Select an instance or launch a project
                </p>
                <p className="mt-1 text-xs text-neutral-600">
                  Choose a project from the sidebar to get started
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      <Sidebar
        projects={projects}
        projectsLoading={projectsLoading}
        projectsRefreshing={projectsRefreshing}
        instances={instances}
        selectedInstanceId={selectedInstanceId}
        scanPaths={config?.scanPaths ?? []}
        queuedIds={queuedIds}
        onRefreshProjects={refreshProjects}
        onLaunchProject={handleLaunch}
        onSelectInstance={setSelectedInstanceId}
        onKillInstance={handleKill}
        onDeleteWorktree={handleDeleteWorktree}
        onOpenScanPaths={() => setScanPathsOpen(true)}
      />

      {scanPathsOpen && (
        <ScanPathsModal
          scanPaths={config?.scanPaths ?? []}
          onSave={handleSaveScanPaths}
          onClose={() => setScanPathsOpen(false)}
        />
      )}
    </div>
  );
}
