import { Search, RefreshCw, Loader, Plus, Trash2, GitBranch, X, RotateCw } from 'lucide-react';
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

function sourceLabel(source: { source: string; repo?: string; url?: string; path?: string }): string {
  if (source.repo) return source.repo;
  if (source.url) return source.url;
  if (source.path) return source.path;
  return source.source;
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
    installingPlugins,
    refreshMarketplace,
    sources,
    addSource,
    removeSource,
    addingSource,
    removingSource,
    toggleAutoUpdate,
  } = useMarketplace();

  const [selectedPlugin, setSelectedPlugin] = useState<PluginMetadata | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addRepoInput, setAddRepoInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [addAutoUpdate, setAddAutoUpdate] = useState(true);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshMarketplace();
    setRefreshing(false);
  };

  const handleAddSource = async () => {
    if (!addRepoInput.trim()) return;
    setAddError(null);
    const result = await addSource(addRepoInput.trim(), addAutoUpdate);
    if (result.error) {
      setAddError(result.error);
    } else {
      setAddRepoInput('');
      setShowAddForm(false);
      setAddAutoUpdate(true);
    }
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
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSources(!showSources)}
              className={`rounded p-1 transition-colors ${
                showSources ? 'text-blue-400' : 'text-neutral-600 hover:text-neutral-400'
              }`}
              title="Manage marketplace sources"
            >
              <GitBranch className="h-3 w-3" />
            </button>
            <button
              onClick={() => { setShowAddForm(!showAddForm); setAddError(null); }}
              className={`rounded p-1 transition-colors ${
                showAddForm ? 'text-green-400' : 'text-neutral-600 hover:text-neutral-400'
              }`}
              title="Add marketplace source"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              onClick={handleRefresh}
              className="rounded p-1 text-neutral-600 transition-colors hover:text-neutral-400"
              title="Refresh marketplaces"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Add marketplace form */}
        {showAddForm && (
          <div className="mx-3 mb-2 rounded-lg border border-neutral-800 bg-[#0d0d0d] p-2">
            <div className="mb-1.5 text-[10px] text-neutral-500">
              Add a marketplace by GitHub repo or git URL
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={addRepoInput}
                onChange={e => { setAddRepoInput(e.target.value); setAddError(null); }}
                onKeyDown={e => { if (e.key === 'Enter') handleAddSource(); }}
                placeholder="owner/repo or https://..."
                className="flex-1 rounded bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300 placeholder-neutral-700 outline-none focus:ring-1 focus:ring-neutral-700"
                autoFocus
                disabled={addingSource}
              />
              <button
                onClick={handleAddSource}
                disabled={addingSource || !addRepoInput.trim()}
                className="rounded bg-green-900/50 px-2.5 py-1 text-[10px] font-medium text-green-400 transition-colors hover:bg-green-900/70 disabled:opacity-40"
              >
                {addingSource ? (
                  <Loader className="h-3 w-3 animate-spin" />
                ) : 'Add'}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={addAutoUpdate}
                onChange={e => setAddAutoUpdate(e.target.checked)}
                className="h-3 w-3 rounded border-neutral-700 bg-neutral-900 accent-green-500"
              />
              <span className="text-[10px] text-neutral-500">Auto-update on refresh</span>
            </label>
            {addError && (
              <div className="mt-1.5 text-[10px] text-red-400">{addError}</div>
            )}
          </div>
        )}

        {/* Marketplace sources list */}
        {showSources && sources.length > 0 && (
          <div className="mx-3 mb-2 rounded-lg border border-neutral-800 bg-[#0d0d0d] p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-medium text-neutral-500">
                Marketplace Sources ({sources.length})
              </span>
              <button
                onClick={() => setShowSources(false)}
                className="rounded p-0.5 text-neutral-600 hover:text-neutral-400"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
            <div className="space-y-1">
              {sources.map(src => (
                <div
                  key={src.name}
                  className="flex items-center justify-between rounded px-2 py-1 text-[10px] hover:bg-neutral-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-neutral-300">
                      {marketplaceDisplayName(src.name)}
                    </div>
                    <div className="truncate text-neutral-600">
                      {sourceLabel(src.source)} &middot; {src.pluginCount} plugin{src.pluginCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => toggleAutoUpdate(src.name, !src.autoUpdate)}
                    className={`ml-1 shrink-0 rounded p-1 transition-colors ${
                      src.autoUpdate
                        ? 'text-green-500 hover:text-green-400'
                        : 'text-neutral-700 hover:text-neutral-500'
                    }`}
                    title={src.autoUpdate ? 'Auto-update enabled (click to disable)' : 'Auto-update disabled (click to enable)'}
                  >
                    <RotateCw className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => removeSource(src.name)}
                    disabled={removingSource === src.name}
                    className="ml-2 shrink-0 rounded p-1 text-neutral-700 transition-colors hover:text-red-400 disabled:opacity-40"
                    title={`Remove ${src.name}`}
                  >
                    {removingSource === src.name ? (
                      <Loader className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

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
        <div className="flex flex-wrap gap-1 px-3 pb-2">
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
            <div className="py-6 text-center">
              <p className="text-[12px] text-neutral-700">
                {search ? 'No plugins match your search' : 'No plugins found'}
              </p>
              {!search && sources.length === 0 && (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-neutral-800/50 px-3 py-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
                >
                  <Plus className="h-3 w-3" />
                  Add a marketplace source
                </button>
              )}
            </div>
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
                  isLoading={installingPlugins.has(`${plugin.marketplace}/${plugin.name}`)}
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
