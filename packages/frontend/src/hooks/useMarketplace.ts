import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PluginMetadata } from '../types';

export function useMarketplace() {
  const [plugins, setPlugins] = useState<PluginMetadata[]>([]);
  const [loading, setLoading] = useState(true);
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

  const installPlugin = useCallback(async (marketplace: string, name: string) => {
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
    }
  }, []);

  const uninstallPlugin = useCallback(async (marketplace: string, name: string) => {
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
    refreshMarketplace,
    refetch: fetchPlugins,
  };
}
