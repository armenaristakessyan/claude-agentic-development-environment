import { useState, useRef, useEffect, useCallback } from 'react';
import type { EffortLevel, ModelOption, TaskWarmupResult } from '../types';

interface PrefetchResponse {
  slashCommands: string[];
  models: Array<{
    value: string;
    displayName: string;
    description?: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: EffortLevel[];
  }>;
  mcpServers?: { name: string; status: string }[];
  tools?: string[];
  cliVersion?: string | null;
}

interface InFlight {
  cancel: () => void;
}

const RETRY_DELAYS = [500, 1000, 2000, 4000];

export function useTaskWarmup() {
  const [results, setResults] = useState<Record<string, TaskWarmupResult>>({});
  const [warmingIds, setWarmingIds] = useState<Set<string>>(() => new Set());

  // trackedRef prevents a second warm() call for the same id while the first
  // is still in flight OR has already completed successfully. Kept in a ref
  // so warm() can consult it synchronously.
  const trackedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Map<string, InFlight>>(new Map());

  const warm = useCallback((instanceId: string) => {
    if (!instanceId) return;
    if (trackedRef.current.has(instanceId)) return;
    trackedRef.current.add(instanceId);

    const signal = { cancelled: false };
    const timers: ReturnType<typeof setTimeout>[] = [];
    let attempt = 0;
    let gotModels = false;
    let firstResponseHandled = false;

    const nextDelay = () => RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)] ?? 5000;

    const run = async () => {
      if (signal.cancelled) return;
      try {
        const res = await fetch(`/api/instances/${instanceId}/prefetch`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as PrefetchResponse;
        if (signal.cancelled) return;

        const opts: ModelOption[] = (data.models ?? []).map(m => ({
          id: m.value,
          label: m.displayName,
          description: m.description,
          supportsEffort: m.supportsEffort,
          supportedEffortLevels: m.supportedEffortLevels,
        }));
        if (opts.length > 0) gotModels = true;

        setResults(prev => {
          const current = prev[instanceId];
          return {
            ...prev,
            [instanceId]: {
              modelOptions: opts.length > 0 ? opts : (current?.modelOptions ?? []),
              slashCommands: (data.slashCommands?.length ?? 0) > 0
                ? data.slashCommands
                : (current?.slashCommands ?? []),
              mcpServers: (data.mcpServers?.length ?? 0) > 0
                ? data.mcpServers!
                : (current?.mcpServers ?? []),
              tools: (data.tools?.length ?? 0) > 0
                ? data.tools!
                : (current?.tools ?? []),
              cliVersion: data.cliVersion ?? current?.cliVersion ?? null,
            },
          };
        });
      } catch (err) {
        console.error('[task-warmup] prefetch failed:', err);
        if (!signal.cancelled) {
          setResults(prev => {
            if (prev[instanceId]) return prev;
            return { ...prev, [instanceId]: { modelOptions: [], slashCommands: [], mcpServers: [], tools: [], cliVersion: null } };
          });
        }
      } finally {
        if (!signal.cancelled && !firstResponseHandled) {
          firstResponseHandled = true;
          setWarmingIds(prev => {
            if (!prev.has(instanceId)) return prev;
            const next = new Set(prev);
            next.delete(instanceId);
            return next;
          });
        }
        if (!signal.cancelled && !gotModels) {
          attempt++;
          timers.push(setTimeout(run, nextDelay()));
        } else if (!signal.cancelled) {
          inFlightRef.current.delete(instanceId);
        }
      }
    };

    inFlightRef.current.set(instanceId, {
      cancel: () => {
        signal.cancelled = true;
        timers.forEach(clearTimeout);
      },
    });

    setWarmingIds(prev => {
      if (prev.has(instanceId)) return prev;
      const next = new Set(prev);
      next.add(instanceId);
      return next;
    });

    run();
  }, []);

  const invalidate = useCallback((instanceId?: string) => {
    if (instanceId) {
      inFlightRef.current.get(instanceId)?.cancel();
      inFlightRef.current.delete(instanceId);
      trackedRef.current.delete(instanceId);
      setResults(prev => {
        if (!(instanceId in prev)) return prev;
        const next = { ...prev };
        delete next[instanceId];
        return next;
      });
      setWarmingIds(prev => {
        if (!prev.has(instanceId)) return prev;
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
      return;
    }
    for (const inFlight of inFlightRef.current.values()) inFlight.cancel();
    inFlightRef.current.clear();
    trackedRef.current.clear();
    setResults({});
    setWarmingIds(new Set());
  }, []);

  useEffect(() => {
    const inFlight = inFlightRef.current;
    return () => {
      for (const entry of inFlight.values()) entry.cancel();
      inFlight.clear();
    };
  }, []);

  return { warm, warmingIds, results, invalidate };
}
