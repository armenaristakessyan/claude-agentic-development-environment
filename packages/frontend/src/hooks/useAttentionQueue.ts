import { useState, useRef, useCallback, useEffect } from 'react';
import type { Instance, AttentionQueueItem } from '../types';

interface UseAttentionQueueOptions {
  instances: Instance[];
  selectedInstanceId: string | null;
  onSelectInstance: (id: string) => void;
  typingLocked: boolean;
}

// Both waiting_input and idle mean "waiting for user input"
function isWaitingForUser(status: string): boolean {
  return status === 'waiting_input' || status === 'idle';
}

export function useAttentionQueue({
  instances,
  selectedInstanceId,
  onSelectInstance,
  typingLocked,
}: UseAttentionQueueOptions) {
  const [queue, setQueue] = useState<AttentionQueueItem[]>([]);
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const prevFrontRef = useRef<string | null>(null);

  // Rebuild queue whenever instances or skippedIds change.
  // Queue = all instances waiting for user input minus manually skipped.
  useEffect(() => {
    const now = Date.now();

    setQueue(prev => {
      // Preserve entry times from previous queue
      const existingTimes = new Map<string, number>();
      for (const item of prev) {
        existingTimes.set(item.instanceId, item.enteredAt);
      }

      const newQueue = instances
        .filter(i => isWaitingForUser(i.status) && !skippedIds.has(i.id))
        .map(i => ({
          instanceId: i.id,
          projectName: i.projectName,
          enteredAt: existingTimes.get(i.id) ?? now,
        }))
        .sort((a, b) => a.enteredAt - b.enteredAt);

      // Avoid unnecessary state update if queue membership hasn't changed
      if (
        newQueue.length === prev.length &&
        newQueue.every((item, idx) => item.instanceId === prev[idx].instanceId)
      ) {
        return prev;
      }

      return newQueue;
    });
  }, [instances, skippedIds]);

  // Clean up skippedIds only when an instance leaves the "waiting" states
  // (i.e. goes to processing/exited/removed — meaning the user interacted).
  // Don't clean on idle since idle is still "waiting for user".
  useEffect(() => {
    const activelyWaiting = new Set(
      instances.filter(i => isWaitingForUser(i.status)).map(i => i.id),
    );
    const currentIds = new Set(instances.map(i => i.id));

    setSkippedIds(prev => {
      let changed = false;
      for (const id of prev) {
        // Only clear skip if instance went to processing/exited or was removed
        if (!activelyWaiting.has(id) && (!currentIds.has(id) || !isWaitingForUser(instances.find(i => i.id === id)?.status ?? ''))) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (activelyWaiting.has(id)) next.add(id);
      }
      return next;
    });
  }, [instances]);

  // Auto-select front of queue when a NEW instance enters the front.
  // Do NOT switch away when the current instance leaves the queue (e.g. goes to processing).
  useEffect(() => {
    if (typingLocked) return;

    const frontId = queue.length > 0 ? queue[0].instanceId : null;
    if (frontId && frontId !== prevFrontRef.current) {
      // Only auto-switch if the selected instance is NOT currently processing
      // (i.e. user just sent a message — don't yank them away)
      const selectedInstance = instances.find(i => i.id === selectedInstanceId);
      const selectedIsProcessing = selectedInstance?.status === 'processing';
      if (!selectedIsProcessing) {
        onSelectInstance(frontId);
      }
    }
    prevFrontRef.current = frontId;
  }, [queue, onSelectInstance, typingLocked, instances, selectedInstanceId]);

  const skipInstance = useCallback((id: string) => {
    setSkippedIds(prev => new Set(prev).add(id));
  }, []);

  const jumpToInstance = useCallback((id: string) => {
    onSelectInstance(id);
  }, [onSelectInstance]);

  return { queue, skipInstance, jumpToInstance };
}
