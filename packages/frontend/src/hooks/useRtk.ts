import { useState, useEffect, useCallback } from 'react';
import type { RtkStatus, RtkStats } from '../types';

const DISMISS_KEY = 'rtk-install-dismissed';

export function useRtk() {
  const [status, setStatus] = useState<RtkStatus | null>(null);
  const [stats, setStats] = useState<RtkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/rtk/status');
      const data = await res.json() as RtkStatus;
      setStatus(data);
      return data;
    } catch (err) {
      console.error('Failed to fetch RTK status:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/rtk/stats');
      if (!res.ok) return;
      const data = await res.json() as RtkStats;
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch RTK stats:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus().then(s => {
      if (s?.installed && s.hooksInstalled) {
        fetchStats();
      }
    });
  }, [fetchStatus, fetchStats]);

  useEffect(() => {
    if (!status?.installed || !status?.hooksInstalled) return;
    const interval = setInterval(fetchStats, 60_000);
    return () => clearInterval(interval);
  }, [status?.installed, status?.hooksInstalled, fetchStats]);

  const installHooks = useCallback(async () => {
    setInstalling(true);
    try {
      const res = await fetch('/api/rtk/install-hooks', { method: 'POST' });
      const data = await res.json() as { success: boolean; output: string };
      if (data.success) {
        await fetchStatus();
        await fetchStats();
      }
    } catch (err) {
      console.error('Failed to install RTK hooks:', err);
    } finally {
      setInstalling(false);
    }
  }, [fetchStatus, fetchStats]);

  const uninstallHooks = useCallback(async () => {
    try {
      await fetch('/api/rtk/uninstall-hooks', { method: 'POST' });
      await fetchStatus();
      setStats(null);
    } catch (err) {
      console.error('Failed to uninstall RTK hooks:', err);
    }
  }, [fetchStatus]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, '1');
  }, []);

  const undismiss = useCallback(() => {
    setDismissed(false);
    localStorage.removeItem(DISMISS_KEY);
  }, []);

  return {
    status,
    stats,
    loading,
    installing,
    installHooks,
    uninstallHooks,
    refreshStatus: fetchStatus,
    refreshStats: fetchStats,
    dismissed,
    dismiss,
    undismiss,
  };
}
