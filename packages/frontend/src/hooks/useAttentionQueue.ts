import { useState, useEffect } from 'react';
import type { Instance, AttentionQueueItem } from '../types';

interface UseAttentionQueueOptions {
  instances: Instance[];
}

function isWaitingForUser(status: string): boolean {
  return status === 'waiting_input' || status === 'idle';
}

export function useAttentionQueue({ instances }: UseAttentionQueueOptions) {
  const [queue, setQueue] = useState<AttentionQueueItem[]>([]);

  useEffect(() => {
    const now = Date.now();

    setQueue(prev => {
      const existingTimes = new Map<string, number>();
      for (const item of prev) {
        existingTimes.set(item.instanceId, item.enteredAt);
      }

      const newQueue = instances
        .filter(i => isWaitingForUser(i.status))
        .map(i => ({
          instanceId: i.id,
          projectName: i.projectName,
          enteredAt: existingTimes.get(i.id) ?? now,
        }))
        .sort((a, b) => a.enteredAt - b.enteredAt);

      if (
        newQueue.length === prev.length &&
        newQueue.every((item, idx) => item.instanceId === prev[idx].instanceId)
      ) {
        return prev;
      }

      return newQueue;
    });
  }, [instances]);

  return { queue };
}
