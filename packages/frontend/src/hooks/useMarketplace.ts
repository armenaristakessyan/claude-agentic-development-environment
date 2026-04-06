import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PluginMetadata } from '../types';

export function useMarketplace() {
  const [plugins, setPlugins] = useState<PluginMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState<string | null>(null);

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
  }, [fetchPlugins]);

  /** Send /reload-plugins to all active instances so Claude picks up changes */
  const reloadPluginsOnInstances = useCallback(async () => {
    try {
      const res = await fetch('/api/instances');
      if (!res.ok) return;
      const instances = await res.json() as { id: string; status: string }[];
      for (const inst of instances) {
        if (inst.status === 'waiting_input') {
          await fetch(`/api/instances/${inst.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: '/reload-plugins', hidden: true }),
          }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
    window.dispatchEvent(new Event('plugins-changed'));
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
        await reloadPluginsOnInstances();
      }
    } catch (err) {
      console.error('Failed to install plugin:', err);
    } finally {
      setInstallingPlugins(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [reloadPluginsOnInstances]);

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
        await reloadPluginsOnInstances();
      }
    } catch (err) {
      console.error('Failed to uninstall plugin:', err);
    } finally {
      setInstallingPlugins(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [reloadPluginsOnInstances]);

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
  };
}
