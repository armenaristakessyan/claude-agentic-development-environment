import { X, Check, Download, Shield, Wrench, Terminal, Ban, ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { PluginMetadata, SkillDetail } from '../types';

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function marketplaceLabel(marketplace: string): string {
  if (marketplace === 'claude-plugins-official') return 'Official';
  if (marketplace === 'shared-claude-marketplace-lib') return 'Agicap Internal';
  return marketplace;
}

interface PluginDetailModalProps {
  plugin: PluginMetadata;
  onClose: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

export default function PluginDetailModal({ plugin, onClose, onInstall, onUninstall }: PluginDetailModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-default bg-modal"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border-default px-5 py-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-primary">{plugin.name}</h2>
              {plugin.version && (
                <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-tertiary">
                  v{plugin.version}
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2">
              {plugin.author && (
                <span className="text-[12px] text-muted">{plugin.author.name}</span>
              )}
              <span className="rounded bg-elevated/50 px-1.5 py-0.5 text-[10px] text-muted">
                {marketplaceLabel(plugin.marketplace)}
              </span>
              {plugin.segment && (
                <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-400">
                  {plugin.segment}
                </span>
              )}
              {plugin.installCount != null && plugin.installCount > 0 && (
                <span className="flex items-center gap-0.5 text-[10px] text-muted">
                  <Download className="h-2.5 w-2.5" />
                  {formatCount(plugin.installCount)} installs
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-faint transition-colors hover:text-tertiary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Description */}
          <p className="text-[13px] leading-relaxed text-tertiary">
            {plugin.description || 'No description provided.'}
          </p>

          {/* Keywords */}
          {plugin.keywords && plugin.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {plugin.keywords.map(kw => (
                <span key={kw} className="rounded bg-elevated/70 px-2 py-0.5 text-[10px] text-tertiary">
                  {kw}
                </span>
              ))}
            </div>
          )}

          {/* Install button */}
          <div className="mt-4">
            {plugin.isInstalled ? (
              <button
                onClick={onUninstall}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-[12px] text-red-400 transition-colors hover:bg-red-500/20"
              >
                <X className="h-3.5 w-3.5" />
                Uninstall
              </button>
            ) : (
              <button
                onClick={onInstall}
                className="flex items-center gap-1.5 rounded-lg bg-blue-500/15 px-3 py-1.5 text-[12px] text-blue-400 transition-colors hover:bg-blue-500/25"
              >
                <Download className="h-3.5 w-3.5" />
                Install
              </button>
            )}
          </div>

          {/* Skills */}
          {plugin.skills.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
                Skills ({plugin.skills.length})
              </h3>
              <div className="flex flex-col gap-1">
                {plugin.skills.map(skill => (
                  <SkillRow
                    key={skill.name}
                    skillName={skill.name}
                    description={skill.description}
                    marketplace={plugin.marketplace}
                    pluginName={plugin.name}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Skill Row with expandable detail ---

function SkillRow({
  skillName,
  description,
  marketplace,
  pluginName,
}: {
  skillName: string;
  description: string;
  marketplace: string;
  pluginName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded || detail) return;
    setLoading(true);
    fetch(`/api/marketplace/plugins/${marketplace}/${pluginName}/skills/${skillName}`)
      .then(res => res.ok ? res.json() as Promise<SkillDetail> : null)
      .then(data => { setDetail(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [expanded, detail, marketplace, pluginName, skillName]);

  return (
    <div className="rounded-lg border border-border-default bg-root">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-faint" />
        )}
        <span className="text-[12px] font-medium text-secondary">/{skillName}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-faint">{description}</span>
      </button>

      {expanded && (
        <div className="border-t border-border-default px-3 py-2.5">
          {loading && (
            <p className="text-[11px] text-faint">Loading...</p>
          )}
          {detail && (
            <div className="flex flex-col gap-2">
              {/* Allowed tools */}
              {detail.allowedTools && detail.allowedTools.length > 0 && (
                <div className="flex items-start gap-2">
                  <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-faint" />
                  <div className="flex flex-wrap gap-1">
                    {detail.allowedTools.map(t => (
                      <span key={t} className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-tertiary">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Scope contract */}
              {detail.scope && (
                <div className="flex flex-col gap-1.5">
                  {detail.scope.maxSteps != null && (
                    <div className="flex items-center gap-2">
                      <Shield className="h-3 w-3 shrink-0 text-faint" />
                      <span className="text-[10px] text-muted">
                        Max steps: {detail.scope.maxSteps}
                      </span>
                    </div>
                  )}
                  {detail.scope.allowedCommands && detail.scope.allowedCommands.length > 0 && (
                    <div className="flex items-start gap-2">
                      <Terminal className="mt-0.5 h-3 w-3 shrink-0 text-faint" />
                      <div className="flex flex-wrap gap-1">
                        {detail.scope.allowedCommands.map(c => (
                          <span key={c} className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {detail.scope.forbiddenPatterns && detail.scope.forbiddenPatterns.length > 0 && (
                    <div className="flex items-start gap-2">
                      <Ban className="mt-0.5 h-3 w-3 shrink-0 text-red-500/50" />
                      <div className="flex flex-wrap gap-1">
                        {detail.scope.forbiddenPatterns.map(p => (
                          <span key={p} className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!loading && !detail && (
            <p className="text-[11px] text-faint">Could not load skill details.</p>
          )}
        </div>
      )}
    </div>
  );
}
