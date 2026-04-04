import { useState, useEffect, useCallback } from 'react';

interface StoredTask {
  id: string;
  projectPath: string;
  projectName: string;
  taskDescription: string | null;
  worktreePath: string | null;
  parentProjectPath: string | null;
  branchName: string | null;
  sessionId: string | null;
  status: 'active' | 'exited';
  createdAt: string;
  exitedAt: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  worktreeExists?: boolean;
}

export function useTaskHistory() {
  const [tasks, setTasks] = useState<StoredTask[]>([]);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json() as StoredTask[];
      setTasks(data);
    } catch (err) {
      console.error('Failed to fetch task history:', err);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const removeTask = useCallback(async (taskId: string) => {
    try {
      await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('Failed to remove task:', err);
    }
  }, []);

  const resumeTask = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/resume`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to resume task');
      }
      const instance = await res.json();
      // Refresh the task list
      await fetchTasks();
      return instance;
    } catch (err) {
      console.error('Failed to resume task:', err);
      throw err;
    }
  }, [fetchTasks]);

  return { tasks, fetchTasks, removeTask, resumeTask };
}

export type { StoredTask };
