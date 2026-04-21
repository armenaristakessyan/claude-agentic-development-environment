import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PluginMetadata } from '../types';
import { useSocket } from './useSocket';

export interface MarketplaceSourceInfo {
  name: string;
  source: { source: string; repo?: string; url?: string; path?: string };
  pluginCount: number;
  lastUpdated: string;
  autoUpdate: boolean;
}

export function useMarketplace() {
  const [plugins, setPlugins] = useState<PluginMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState<string | null>(null);
  const [sources, setSources] = useState<MarketplaceSourceInfo[]>([]);
  const [addingSource, setAddingSource] = useState(false);
  const [removingSource, setRemovingSource] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch('/api/marketplace/sources');
      if (res.ok) {
        const data = await res.json() as MarketplaceSourceInfo[];
        setSources(data);
      }
    } catch (err) {
      console.error('Failed to fetch marketplace sources:', err);
    }
  }, []);

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/marketplace/plugins');
      if (res.ok) {
        const data = await res.json() as PluginMetadata[];
        setPlugins(data);
      }
    } catch (err) {
      console.error('Failed to fetch marketplace plugins:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
    fetchSources();
  }, [fetchPlugins, fetchSources]);

  // Backend broadcasts `marketplace:updated` whenever sources/plugins change
  // (install, uninstall, add, remove, auto-update). Refetch so all open tabs stay in sync.
  const socket = useSocket();
  useEffect(() => {
    const handler = () => {
      fetchPlugins();
      fetchSources();
    };
    socket.on('marketplace:updated', handler);
    return () => { socket.off('marketplace:updated', handler); };
  }, [socket, fetchPlugins, fetchSources]);

  const addSource = useCallback(async (repo: string, autoUpdate = true): Promise<{ name: string; pluginCount: number; error?: string }> => {
    setAddingSource(true);
    try {
      const res = await fetch('/api/marketplace/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, autoUpdate }),
      });
      const data = await res.json() as { name?: string; pluginCount?: number; error?: string };
      if (!res.ok) {
        return { name: '', pluginCount: 0, error: data.error ?? 'Failed to add marketplace' };
      }
      await fetchSources();
      await fetchPlugins();
      return { name: data.name ?? repo, pluginCount: data.pluginCount ?? 0 };
    } catch (err) {
      console.error('Failed to add marketplace source:', err);
      return { name: '', pluginCount: 0, error: 'Network error adding marketplace' };
    } finally {
      setAddingSource(false);
    }
  }, [fetchSources, fetchPlugins]);

  const removeSource = useCallback(async (name: string, deleteFiles = true) => {
    setRemovingSource(name);
    try {
      const res = await fetch(`/api/marketplace/${encodeURIComponent(name)}?deleteFiles=${deleteFiles}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchSources();
        await fetchPlugins();
      }
    } catch (err) {
      console.error('Failed to remove marketplace source:', err);
    } finally {
      setRemovingSource(null);
    }
  }, [fetchSources, fetchPlugins]);

  const toggleAutoUpdate = useCallback(async (name: string, autoUpdate: boolean) => {
    try {
      const res = await fetch(`/api/marketplace/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUpdate }),
      });
      if (res.ok) {
        setSources(prev => prev.map(s => s.name === name ? { ...s, autoUpdate } : s));
      }
    } catch (err) {
      console.error('Failed to toggle autoUpdate:', err);
    }
  }, []);

  const installPlugin = useCallback(async (marketplace: string, name: string) => {
    const key = `${marketplace}/${name}`;
    setInstallingPlugins(prev => new Set(prev).add(key));
    try {
      const res = await fetch(`/api/marketplace/plugins/${marketplace}/${name}/install`, { method: 'POST' });
      if (res.ok) {
        setPlugins(prev => prev.map(p =>
          p.marketplace === marketplace && p.name === name
            ? { ...p, isInstalled: true }
            : p
        ));
      }
    } catch (err) {
      console.error('Failed to install plugin:', err);
    } finally {
      setInstallingPlugins(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, []);

  const uninstallPlugin = useCallback(async (marketplace: string, name: string) => {
    const key = `${marketplace}/${name}`;
    setInstallingPlugins(prev => new Set(prev).add(key));
    try {
      const res = await fetch(`/api/marketplace/plugins/${marketplace}/${name}/uninstall`, { method: 'POST' });
      if (res.ok) {
        setPlugins(prev => prev.map(p =>
          p.marketplace === marketplace && p.name === name
            ? { ...p, isInstalled: false }
            : p
        ));
      }
    } catch (err) {
      console.error('Failed to uninstall plugin:', err);
    } finally {
      setInstallingPlugins(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, []);

  const refreshMarketplace = useCallback(async () => {
    try {
      await fetch('/api/marketplace/refresh', { method: 'POST' });
      await fetchPlugins();
    } catch (err) {
      console.error('Failed to refresh marketplace:', err);
    }
  }, [fetchPlugins]);

  const filtered = useMemo(() => {
    let result = plugins;
    if (marketplaceFilter) {
      result = result.filter(p => p.marketplace === marketplaceFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.segment?.toLowerCase().includes(q) ||
        p.keywords?.some(k => k.toLowerCase().includes(q)) ||
        p.skills.some(s => s.name.toLowerCase().includes(q))
      );
    }
    return result;
  }, [plugins, marketplaceFilter, search]);

  // Get unique marketplace names for filter
  const marketplaceNames = useMemo(() => {
    const names = new Set(plugins.map(p => p.marketplace));
    return Array.from(names).sort();
  }, [plugins]);

  return {
    plugins: filtered,
    allPlugins: plugins,
    loading,
    search,
    setSearch,
    marketplaceFilter,
    setMarketplaceFilter,
    marketplaceNames,
    installPlugin,
    uninstallPlugin,
    installingPlugins,
    refreshMarketplace,
    refetch: fetchPlugins,
    sources,
    addSource,
    removeSource,
    addingSource,
    removingSource,
    toggleAutoUpdate,
  };
}
