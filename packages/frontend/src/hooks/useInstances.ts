import { useState, useEffect, useCallback } from 'react';
import type { Instance, InstanceStatus } from '../types';
import { useSocket } from './useSocket';

export function useInstances() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const socket = useSocket();

  const fetchInstances = useCallback(async () => {
    try {
      const res = await fetch('/api/instances');
      const data = await res.json() as Instance[];
      setInstances(data);
    } catch (err) {
      console.error('Failed to fetch instances:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  useEffect(() => {
    const handleStatus = ({ instanceId, status }: { instanceId: string; status: InstanceStatus }) => {
      setInstances(prev =>
        prev.map(inst =>
          inst.id === instanceId ? { ...inst, status } : inst,
        ),
      );
    };

    const handleExited = ({ instanceId, exitCode }: { instanceId: string; exitCode: number }) => {
      console.log(`Instance ${instanceId} exited with code ${exitCode}`);
      setInstances(prev =>
        prev.map(inst =>
          inst.id === instanceId ? { ...inst, status: 'exited' as const } : inst,
        ),
      );
    };

    const handleResult = ({ instanceId, costUsd, totalInputTokens, totalOutputTokens }: {
      instanceId: string; costUsd: number; totalInputTokens: number; totalOutputTokens: number;
    }) => {
      setInstances(prev =>
        prev.map(inst =>
          inst.id === instanceId
            ? {
                ...inst,
                totalCostUsd: inst.totalCostUsd + (costUsd ?? 0),
                totalInputTokens: totalInputTokens ?? inst.totalInputTokens,
                totalOutputTokens: totalOutputTokens ?? inst.totalOutputTokens,
              }
            : inst,
        ),
      );
    };

    socket.on('instance:status', handleStatus);
    socket.on('instance:exited', handleExited);
    socket.on('chat:result', handleResult);

    return () => {
      socket.off('instance:status', handleStatus);
      socket.off('instance:exited', handleExited);
      socket.off('chat:result', handleResult);
    };
  }, [socket]);

  const spawnInstance = useCallback(async (projectPath: string, taskDescription?: string) => {
    try {
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, taskDescription }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to spawn instance');
      }
      const instance = await res.json() as Instance;
      setInstances(prev => [...prev, instance]);
      return instance;
    } catch (err) {
      console.error('Failed to spawn instance:', err);
      throw err;
    }
  }, []);

  const killInstance = useCallback(async (instanceId: string, deleteWorktree?: boolean) => {
    try {
      const query = deleteWorktree ? '?deleteWorktree=true' : '';
      await fetch(`/api/instances/${instanceId}${query}`, { method: 'DELETE' });
      setInstances(prev => prev.filter(i => i.id !== instanceId));
    } catch (err) {
      console.error('Failed to kill instance:', err);
    }
  }, []);

  return { instances, loading, spawnInstance, killInstance, refetch: fetchInstances };
}
