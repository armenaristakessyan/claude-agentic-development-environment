import { Search, RefreshCw, Loader } from 'lucide-react';
import { useState } from 'react';
import { useMarketplace } from '../hooks/useMarketplace';
import PluginCard from './PluginCard';
import PluginDetailModal from './PluginDetailModal';
import type { PluginMetadata } from '../types';

function marketplaceDisplayName(name: string): string {
  if (name === 'claude-plugins-official') return 'Official';
  if (name === 'shared-claude-marketplace-lib') return 'Agicap';
  return name;
}

export default function MarketplacePanel() {
  const {
    plugins,
    loading,
    search,
    setSearch,
    marketplaceFilter,
    setMarketplaceFilter,
    marketplaceNames,
    installPlugin,
    uninstallPlugin,
    refreshMarketplace,
  } = useMarketplace();

  const [selectedPlugin, setSelectedPlugin] = useState<PluginMetadata | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshMarketplace();
    setRefreshing(false);
  };

  // Group plugins by marketplace when no filter
  const grouped = !marketplaceFilter
    ? marketplaceNames.map(name => ({
        name,
        label: marketplaceDisplayName(name),
        plugins: plugins.filter(p => p.marketplace === name),
      })).filter(g => g.plugins.length > 0)
    : [{ name: marketplaceFilter, label: marketplaceDisplayName(marketplaceFilter), plugins }];

  return (
    <>
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[11px] text-neutral-600">
            {plugins.length} plugin{plugins.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={handleRefresh}
            className="rounded p-1 text-neutral-600 transition-colors hover:text-neutral-400"
            title="Refresh marketplaces"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex items-center gap-1.5 rounded-lg bg-[#0d0d0d] px-2.5 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-neutral-600" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search plugins..."
              className="w-full bg-transparent text-[12px] text-neutral-300 placeholder-neutral-700 outline-none"
            />
          </div>
        </div>

        {/* Filter pills */}
        <div className="flex gap-1 px-3 pb-2">
          <button
            onClick={() => setMarketplaceFilter(null)}
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              !marketplaceFilter
                ? 'bg-neutral-700/40 text-neutral-300'
                : 'text-neutral-600 hover:text-neutral-400'
            }`}
          >
            All
          </button>
          {marketplaceNames.map(name => (
            <button
              key={name}
              onClick={() => setMarketplaceFilter(marketplaceFilter === name ? null : name)}
              className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                marketplaceFilter === name
                  ? 'bg-neutral-700/40 text-neutral-300'
                  : 'text-neutral-600 hover:text-neutral-400'
              }`}
            >
              {marketplaceDisplayName(name)}
            </button>
          ))}
        </div>

        {/* Plugin list */}
        <div className="flex-1 overflow-y-auto px-1">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader className="h-4 w-4 animate-spin text-neutral-600" />
            </div>
          )}

          {!loading && plugins.length === 0 && (
            <p className="py-6 text-center text-[12px] text-neutral-700">
              {search ? 'No plugins match your search' : 'No plugins found'}
            </p>
          )}

          {!loading && grouped.map(group => (
            <div key={group.name} className="mb-2">
              {!marketplaceFilter && (
                <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                    {group.label}
                  </span>
                  <span className="text-[10px] text-neutral-700">({group.plugins.length})</span>
                </div>
              )}
              {group.plugins.map(plugin => (
                <PluginCard
                  key={`${plugin.marketplace}/${plugin.name}`}
                  plugin={plugin}
                  onClick={() => setSelectedPlugin(plugin)}
                  onInstall={() => installPlugin(plugin.marketplace, plugin.name)}
                  onUninstall={() => uninstallPlugin(plugin.marketplace, plugin.name)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Detail modal */}
      {selectedPlugin && (
        <PluginDetailModal
          plugin={selectedPlugin}
          onClose={() => setSelectedPlugin(null)}
          onInstall={() => {
            installPlugin(selectedPlugin.marketplace, selectedPlugin.name);
            setSelectedPlugin(prev => prev ? { ...prev, isInstalled: true } : null);
          }}
          onUninstall={() => {
            uninstallPlugin(selectedPlugin.marketplace, selectedPlugin.name);
            setSelectedPlugin(prev => prev ? { ...prev, isInstalled: false } : null);
          }}
        />
      )}
    </>
  );
}
