import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import yaml from 'js-yaml';

// Git env to prevent credential prompts from hanging execSync on private repos
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'Never',
};

// --- Types ---

interface MarketplaceSource {
  source: 'github' | 'directory' | 'url';
  repo?: string;
  path?: string;
  url?: string;
  ref?: string;
}

interface MarketplaceEntry {
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
}

/** marketplace.json schema from .claude-plugin/marketplace.json */
interface MarketplaceJson {
  name: string;
  owner?: { name: string; email?: string };
  metadata?: { description?: string; version?: string; pluginRoot?: string };
  plugins: MarketplacePluginEntry[];
}

interface MarketplacePluginEntry {
  name: string;
  source: string | { source: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string };
  description?: string;
  version?: string;
  author?: { name: string; email?: string } | string;
  keywords?: string[];
  category?: string;
  tags?: string[];
}

export interface MarketplaceInfo {
  name: string;
  source: MarketplaceSource;
  pluginCount: number;
  lastUpdated: string;
  autoUpdate: boolean;
}

interface PluginJson {
  name: string;
  version?: string;
  description?: string;
  author?: { name: string; email?: string } | string;
  keywords?: string[];
  mcpServers?: Record<string, unknown>;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: string[];
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
}

interface ScopeContract {
  'allowed-tools'?: string[];
  'max-steps'?: number;
  'allowed-commands'?: string[];
  'forbidden-patterns'?: string[];
  'description-must-contain'?: string[];
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  allowedTools?: string[];
  scope?: {
    allowedTools?: string[];
    maxSteps?: number;
    allowedCommands?: string[];
    forbiddenPatterns?: string[];
  };
}

export interface PluginMetadata {
  name: string;
  version?: string;
  description: string;
  author?: { name: string; email?: string };
  keywords?: string[];
  marketplace: string;
  segment?: string;
  isInstalled: boolean;
  installCount?: number;
  skillCount: number;
  skills: SkillSummary[];
}

// --- Cache ---

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000;

// --- Service ---

export class MarketplaceService extends EventEmitter {
  private pluginCache: CacheEntry<PluginMetadata[]> | null = null;
  private installCountsCache: Map<string, number> | null = null;

  private get claudeDir(): string {
    return join(homedir(), '.claude');
  }

  private get knownMarketplacesPath(): string {
    return join(this.claudeDir, 'plugins', 'known_marketplaces.json');
  }

  private get settingsPath(): string {
    return join(this.claudeDir, 'settings.json');
  }

  private get installCountsPath(): string {
    return join(this.claudeDir, 'plugins', 'install-counts-cache.json');
  }

  // --- Public API ---

  getMarketplaces(): Record<string, MarketplaceEntry> {
    if (!existsSync(this.knownMarketplacesPath)) return {};
    try {
      return JSON.parse(readFileSync(this.knownMarketplacesPath, 'utf-8'));
    } catch (err) {
      console.log('[marketplace] Failed to read known_marketplaces.json:', err);
      return {};
    }
  }

  listMarketplaces(): MarketplaceInfo[] {
    const marketplaces = this.getMarketplaces();
    return Object.entries(marketplaces).map(([name, entry]) => {
      const pluginCount = existsSync(entry.installLocation)
        ? this.discoverPluginDirs(entry.installLocation).length
        : 0;
      return { name, source: entry.source, pluginCount, lastUpdated: entry.lastUpdated, autoUpdate: entry.autoUpdate ?? false };
    });
  }

  /**
   * Add a marketplace by git repo reference.
   * Accepts: "owner/repo", "https://github.com/owner/repo", or full git URL.
   * Clones the repo and registers it in known_marketplaces.json.
   */
  addMarketplace(repoRef: string, autoUpdate = true): { name: string; pluginCount: number } {
    const { gitUrl, source } = this.parseRepoRef(repoRef);

    const marketplacesDir = join(this.claudeDir, 'plugins', 'marketplaces');
    mkdirSync(marketplacesDir, { recursive: true });

    const tempName = source.repo?.split('/').pop() ?? repoRef.split('/').pop()?.replace(/\.git$/, '') ?? 'marketplace';
    const clonePath = join(marketplacesDir, tempName);

    // If we already have this marketplace registered (under its canonical name),
    // reuse that clone instead of re-cloning. Prevents duplicate network hits
    // when the marketplace's internal name differs from the repo name, or when
    // the user re-adds an existing source.
    const existingEntry = this.findExistingEntry(source, gitUrl);
    const existingPath = existingEntry && existsSync(existingEntry.installLocation) && existsSync(join(existingEntry.installLocation, '.git'))
      ? existingEntry.installLocation
      : null;

    const workingPath = existingPath ?? clonePath;

    if (existsSync(workingPath)) {
      if (existsSync(join(workingPath, '.git'))) {
        this.fetchAndReset(workingPath);
      } else {
        console.log(`[marketplace] ${workingPath} exists but is not a git repo, skipping fetch`);
      }
    } else {
      try {
        const refArgs = source.ref ? ['--branch', source.ref] : [];
        const args = ['clone', '--depth', '1', ...refArgs, gitUrl, workingPath];
        execSync(`git ${args.map(shellQuote).join(' ')}`, {
          encoding: 'utf-8',
          timeout: 120_000,
          env: GIT_ENV,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        console.log(`[marketplace] Cloned ${gitUrl} to ${workingPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to clone ${gitUrl}: ${message}`);
      }
    }

    // Parse marketplace.json to get the canonical name
    const marketplaceJsonPath = join(workingPath, '.claude-plugin', 'marketplace.json');
    let marketplaceName = tempName;
    let pluginCount = 0;

    if (existsSync(marketplaceJsonPath)) {
      try {
        const mJson = JSON.parse(readFileSync(marketplaceJsonPath, 'utf-8')) as MarketplaceJson;
        marketplaceName = mJson.name ?? tempName;
        pluginCount = mJson.plugins?.length ?? 0;
      } catch (err) {
        console.log('[marketplace] Failed to parse marketplace.json:', err);
      }
    }

    // If the clone lives at the temp (repo-name) path but should live under the
    // canonical (marketplace.json) name, rename it once. Never clone twice.
    const canonicalPath = join(marketplacesDir, marketplaceName);
    let finalPath = workingPath;
    if (workingPath !== canonicalPath) {
      if (existsSync(canonicalPath)) {
        // Canonical path already populated — prefer it and drop the temp dir
        if (workingPath === clonePath) rmSync(clonePath, { recursive: true, force: true });
        finalPath = canonicalPath;
      } else {
        renameSync(workingPath, canonicalPath);
        finalPath = canonicalPath;
      }
    }

    // Count plugins from filesystem too (marketplace.json might not list all)
    pluginCount = Math.max(pluginCount, this.discoverPluginDirs(finalPath).length);

    // Register in known_marketplaces.json
    const marketplaces = this.getMarketplaces();
    marketplaces[marketplaceName] = {
      source,
      installLocation: finalPath,
      lastUpdated: new Date().toISOString(),
      autoUpdate,
    };
    this.writeMarketplacesFile(marketplaces);
    this.invalidateCache();

    console.log(`[marketplace] Added marketplace: ${marketplaceName} (${pluginCount} plugins)`);
    this.emit('changed', { reason: 'added', name: marketplaceName });
    return { name: marketplaceName, pluginCount };
  }

  removeMarketplace(name: string, deleteFiles = false): void {
    const marketplaces = this.getMarketplaces();
    const entry = marketplaces[name];
    if (!entry) {
      throw new Error(`Marketplace "${name}" not found`);
    }

    // Uninstall all plugins from this marketplace
    const settings = this.readSettings();
    if (settings.enabledPlugins) {
      const keysToRemove = Object.keys(settings.enabledPlugins)
        .filter(k => k.endsWith(`@${name}`));
      for (const key of keysToRemove) {
        delete settings.enabledPlugins[key];
      }
      this.writeSettings(settings);
    }

    // Optionally delete cloned files
    if (deleteFiles && entry.installLocation && existsSync(entry.installLocation)) {
      rmSync(entry.installLocation, { recursive: true, force: true });
      console.log(`[marketplace] Deleted marketplace files at ${entry.installLocation}`);
    }

    // Remove from known_marketplaces.json
    delete marketplaces[name];
    this.writeMarketplacesFile(marketplaces);
    this.invalidateCache();

    console.log(`[marketplace] Removed marketplace: ${name}`);
    this.emit('changed', { reason: 'removed', name });
  }

  setAutoUpdate(name: string, autoUpdate: boolean): void {
    const marketplaces = this.getMarketplaces();
    const entry = marketplaces[name];
    if (!entry) {
      throw new Error(`Marketplace "${name}" not found`);
    }
    entry.autoUpdate = autoUpdate;
    this.writeMarketplacesFile(marketplaces);
    console.log(`[marketplace] Set autoUpdate=${autoUpdate} for ${name}`);
    this.emit('changed', { reason: 'settings', name });
  }

  /**
   * Find an already-registered marketplace that matches the requested source.
   * Used to avoid re-cloning when a user re-adds an existing marketplace.
   */
  private findExistingEntry(source: MarketplaceSource, gitUrl: string): MarketplaceEntry | null {
    const entries = this.getMarketplaces();
    for (const entry of Object.values(entries)) {
      const s = entry.source;
      if (s.source === 'github' && source.source === 'github' && s.repo === source.repo) return entry;
      if (s.source === 'url' && source.source === 'url' && s.url === source.url) return entry;
      // Cross-match: a URL add that resolves to the same repo as a github-add
      if (s.url === gitUrl || source.url === gitUrl) return entry;
    }
    return null;
  }

  private parseRepoRef(repoRef: string): { gitUrl: string; source: MarketplaceSource } {
    const trimmed = repoRef.trim();

    // Full git URL (https:// or git@)
    if (trimmed.startsWith('https://') || trimmed.startsWith('git@') || trimmed.startsWith('http://')) {
      return {
        gitUrl: trimmed,
        source: { source: 'url', url: trimmed },
      };
    }

    // owner/repo shorthand → GitHub
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      return {
        gitUrl: `https://github.com/${trimmed}.git`,
        source: { source: 'github', repo: trimmed },
      };
    }

    // owner/repo@ref
    const refMatch = trimmed.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)@(.+)$/);
    if (refMatch) {
      return {
        gitUrl: `https://github.com/${refMatch[1]}.git`,
        source: { source: 'github', repo: refMatch[1], ref: refMatch[2] },
      };
    }

    throw new Error(`Invalid marketplace reference: "${trimmed}". Use owner/repo or a full git URL.`);
  }

  private writeMarketplacesFile(data: Record<string, MarketplaceEntry>): void {
    const dir = join(this.claudeDir, 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.knownMarketplacesPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  getPlugins(marketplace?: string, search?: string): PluginMetadata[] {
    let plugins = this.getAllPluginsCached();

    if (marketplace) {
      plugins = plugins.filter(p => p.marketplace === marketplace);
    }

    if (search) {
      const q = search.toLowerCase();
      plugins = plugins.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.segment?.toLowerCase().includes(q) ||
        p.keywords?.some(k => k.toLowerCase().includes(q)) ||
        p.skills.some(s => s.name.toLowerCase().includes(q))
      );
    }

    return plugins;
  }

  getPluginDetail(marketplace: string, pluginName: string): PluginMetadata | null {
    const plugins = this.getAllPluginsCached();
    return plugins.find(p => p.marketplace === marketplace && p.name === pluginName) ?? null;
  }

  getSkillDetail(marketplace: string, pluginName: string, skillName: string): SkillDetail | null {
    const marketplaces = this.getMarketplaces();
    const entry = marketplaces[marketplace];
    if (!entry) return null;

    const pluginDir = this.findPluginDir(entry.installLocation, pluginName);
    if (!pluginDir) return null;

    const skillDir = join(pluginDir, 'skills', skillName);
    const skillMdPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) return null;

    const content = readFileSync(skillMdPath, 'utf-8');
    const frontmatter = this.parseSkillFrontmatter(content);

    let scope: SkillDetail['scope'];
    const scopePath = join(skillDir, 'SCOPE.yaml');
    if (existsSync(scopePath)) {
      const parsed = this.parseScopeYaml(scopePath);
      if (parsed) {
        scope = {
          allowedTools: parsed['allowed-tools'],
          maxSteps: parsed['max-steps'],
          allowedCommands: parsed['allowed-commands'],
          forbiddenPatterns: parsed['forbidden-patterns'],
        };
      }
    }

    return {
      name: frontmatter.name ?? skillName,
      description: frontmatter.description ?? '',
      content,
      allowedTools: frontmatter['allowed-tools'],
      scope,
    };
  }

  installPlugin(marketplace: string, pluginName: string): void {
    const settings = this.readSettings();
    if (!settings.enabledPlugins) {
      settings.enabledPlugins = {};
    }
    const key = `${pluginName}@${marketplace}`;
    settings.enabledPlugins[key] = true;
    this.writeSettings(settings);
    this.invalidateCache();
    console.log(`[marketplace] Installed plugin: ${key}`);
    this.emit('changed', { reason: 'installed', marketplace, plugin: pluginName });
  }

  uninstallPlugin(marketplace: string, pluginName: string): void {
    const settings = this.readSettings();
    if (!settings.enabledPlugins) return;
    const key = `${pluginName}@${marketplace}`;
    delete settings.enabledPlugins[key];
    this.writeSettings(settings);
    this.invalidateCache();
    console.log(`[marketplace] Uninstalled plugin: ${key}`);
    this.emit('changed', { reason: 'uninstalled', marketplace, plugin: pluginName });
  }

  getInstalledPlugins(): string[] {
    const settings = this.readSettings();
    if (!settings.enabledPlugins) return [];
    return Object.keys(settings.enabledPlugins).filter(k => settings.enabledPlugins[k]);
  }

  /** Return filesystem paths for all enabled plugins (for SDK plugin loading) */
  getInstalledPluginPaths(): string[] {
    const installed = this.getInstalledPlugins();
    if (installed.length === 0) return [];

    const marketplaces = this.getMarketplaces();
    const paths: string[] = [];

    for (const key of installed) {
      // Key format: "pluginName@marketplaceName"
      const atIdx = key.lastIndexOf('@');
      if (atIdx < 0) continue;
      const pluginName = key.slice(0, atIdx);
      const marketplaceName = key.slice(atIdx + 1);

      const entry = marketplaces[marketplaceName];
      if (!entry || !existsSync(entry.installLocation)) continue;

      // Search for the plugin directory by matching its .claude-plugin/plugin.json name
      const allDirs = this.discoverPluginDirs(entry.installLocation);
      for (const { dir } of allDirs) {
        const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          if (manifest.name === pluginName) {
            paths.push(dir);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    return paths;
  }

  /**
   * Refresh marketplace repos by pulling latest changes.
   * If a specific marketplace name is given, refreshes only that one (regardless of autoUpdate).
   * If no name is given, refreshes all git-based marketplaces that have autoUpdate enabled.
   */
  /**
   * Refresh marketplace repos. Only invoked by the user clicking "Refresh"
   * in the UI — no background timer. If `marketplace` is given, refresh only
   * that one; otherwise refresh every registered git-backed source.
   */
  async refresh(marketplace?: string): Promise<{ updated: string[]; failed: string[] }> {
    const marketplaces = this.getMarketplaces();
    const updated: string[] = [];
    const failed: string[] = [];

    for (const [name, entry] of Object.entries(marketplaces)) {
      if (marketplace && name !== marketplace) continue;

      const isGit = entry.source.source === 'github' || entry.source.source === 'url';
      if (isGit && existsSync(entry.installLocation) && existsSync(join(entry.installLocation, '.git'))) {
        const ok = this.fetchAndReset(entry.installLocation);
        if (ok) {
          entry.lastUpdated = new Date().toISOString();
          updated.push(name);
          console.log(`[marketplace] Refreshed ${name}`);
        } else {
          failed.push(name);
        }
      }
    }

    if (updated.length > 0) {
      this.writeMarketplacesFile(marketplaces);
    }
    this.invalidateCache();
    if (updated.length > 0 || failed.length > 0) {
      this.emit('changed', { reason: 'refresh', updated, failed });
    }
    return { updated, failed };
  }

  /**
   * Fast-forward a cloned repo to its upstream default branch.
   * Uses fetch + reset --hard to survive a dirty working tree.
   */
  private fetchAndReset(repoPath: string): boolean {
    try {
      execSync('git fetch --depth 1 origin', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 60_000,
        env: GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Determine the ref to reset to: remote HEAD, falling back to current branch
      let ref = 'FETCH_HEAD';
      try {
        const remoteHead = execSync('git symbolic-ref --short refs/remotes/origin/HEAD', {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 10_000,
          env: GIT_ENV,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (remoteHead) ref = remoteHead;
      } catch { /* stick with FETCH_HEAD */ }

      execSync(`git reset --hard ${ref}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
        env: GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch (err) {
      console.log(`[marketplace] fetch/reset failed for ${repoPath}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  // --- Private ---

  private getAllPluginsCached(): PluginMetadata[] {
    if (this.pluginCache && Date.now() - this.pluginCache.timestamp < CACHE_TTL_MS) {
      return this.pluginCache.data;
    }

    const plugins = this.discoverAllPlugins();
    this.pluginCache = { data: plugins, timestamp: Date.now() };
    return plugins;
  }

  private invalidateCache(): void {
    this.pluginCache = null;
    this.installCountsCache = null;
  }

  private discoverAllPlugins(): PluginMetadata[] {
    const marketplaces = this.getMarketplaces();
    const installed = new Set(this.getInstalledPlugins());
    const installCounts = this.getInstallCounts();
    const plugins: PluginMetadata[] = [];

    for (const [marketplaceName, entry] of Object.entries(marketplaces)) {
      if (!existsSync(entry.installLocation)) continue;

      const pluginDirs = this.discoverPluginDirs(entry.installLocation);
      const seen = new Set<string>();

      for (const { dir, segment } of pluginDirs) {
        try {
          const pluginJsonPath = join(dir, '.claude-plugin', 'plugin.json');
          if (!existsSync(pluginJsonPath)) continue;

          const pluginJson: PluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
          if (!pluginJson.name || seen.has(pluginJson.name)) continue;
          seen.add(pluginJson.name);

          const skills = this.discoverSkills(dir);
          const key = `${pluginJson.name}@${marketplaceName}`;

          const author = typeof pluginJson.author === 'string'
            ? { name: pluginJson.author }
            : pluginJson.author;

          plugins.push({
            name: pluginJson.name,
            version: pluginJson.version,
            description: pluginJson.description ?? '',
            author,
            keywords: pluginJson.keywords,
            marketplace: marketplaceName,
            segment,
            isInstalled: installed.has(key),
            installCount: installCounts.get(key),
            skillCount: skills.length,
            skills,
          });
        } catch (err) {
          console.log(`[marketplace] Failed to read plugin at ${dir}:`, err);
        }
      }
    }

    // Sort: installed first, then by install count (desc), then alphabetical
    plugins.sort((a, b) => {
      if (a.isInstalled !== b.isInstalled) return a.isInstalled ? -1 : 1;
      if ((b.installCount ?? 0) !== (a.installCount ?? 0)) return (b.installCount ?? 0) - (a.installCount ?? 0);
      return a.name.localeCompare(b.name);
    });

    return plugins;
  }

  /**
   * Discover all plugin directories for a marketplace installLocation.
   * Primary source: .claude-plugin/marketplace.json's `plugins[].source`.
   * Fallback: recursive filesystem walk rooted at `plugins/` (or pluginRoot).
   */
  private discoverPluginDirs(installLocation: string): Array<{ dir: string; segment?: string }> {
    const result: Array<{ dir: string; segment?: string }> = [];
    const seen = new Set<string>();
    const push = (dir: string, segment?: string) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      result.push({ dir, segment });
    };

    // Primary: read marketplace.json and resolve each plugin's `source` path
    const marketplaceJsonPath = join(installLocation, '.claude-plugin', 'marketplace.json');
    let pluginRoot = 'plugins';
    if (existsSync(marketplaceJsonPath)) {
      try {
        const mJson = JSON.parse(readFileSync(marketplaceJsonPath, 'utf-8')) as MarketplaceJson;
        if (typeof mJson.metadata?.pluginRoot === 'string') {
          pluginRoot = mJson.metadata.pluginRoot.replace(/^\.\//, '');
        }
        for (const p of mJson.plugins ?? []) {
          const sourcePath = this.pluginSourceToPath(p.source, installLocation);
          if (!sourcePath || !existsSync(join(sourcePath, '.claude-plugin', 'plugin.json'))) continue;
          const segment = typeof p.category === 'string' ? p.category : undefined;
          push(sourcePath, segment);
        }
      } catch (err) {
        console.log(`[marketplace] Failed to parse ${marketplaceJsonPath}:`, err);
      }
    }

    // Fallback: recursive filesystem walk (max depth 4 from pluginsDir)
    const pluginsDir = isAbsolute(pluginRoot) ? pluginRoot : join(installLocation, pluginRoot);
    if (existsSync(pluginsDir)) {
      this.walkForPlugins(pluginsDir, pluginsDir, 0, 4, push);
    }

    return result;
  }

  private pluginSourceToPath(
    source: MarketplacePluginEntry['source'],
    installLocation: string,
  ): string | null {
    if (typeof source === 'string') {
      // Treat as a relative path within the marketplace repo
      const rel = source.replace(/^\.\//, '');
      return resolve(installLocation, rel);
    }
    if (source && typeof source === 'object' && source.path) {
      const rel = source.path.replace(/^\.\//, '');
      return resolve(installLocation, rel);
    }
    return null;
  }

  private walkForPlugins(
    root: string,
    dir: string,
    depth: number,
    maxDepth: number,
    push: (dir: string, segment?: string) => void,
  ): void {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // If this dir itself is a plugin, record it and stop descending
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      const rel = dir === root ? '' : dir.slice(root.length + 1);
      const segment = rel.includes('/') ? rel.split('/')[0] : undefined;
      push(dir, segment);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === 'tests') continue;
      this.walkForPlugins(root, join(dir, entry.name), depth + 1, maxDepth, push);
    }
  }

  private findPluginDir(installLocation: string, pluginName: string): string | null {
    if (!existsSync(installLocation)) return null;
    const allDirs = this.discoverPluginDirs(installLocation);
    for (const { dir } of allDirs) {
      try {
        const pj = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8'));
        if (pj.name === pluginName) return dir;
      } catch { /* skip */ }
    }
    return null;
  }

  private discoverSkills(pluginDir: string): SkillSummary[] {
    const skillsDir = join(pluginDir, 'skills');
    if (!existsSync(skillsDir)) return [];

    const skills: SkillSummary[] = [];
    const entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const entry of entries) {
      const skillMd = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;

      try {
        const content = readFileSync(skillMd, 'utf-8');
        const frontmatter = this.parseSkillFrontmatter(content);
        skills.push({
          name: frontmatter.name ?? entry.name,
          description: typeof frontmatter.description === 'string'
            ? frontmatter.description.slice(0, 200)
            : '',
        });
      } catch {
        skills.push({ name: entry.name, description: '' });
      }
    }

    return skills;
  }

  private parseSkillFrontmatter(content: string): SkillFrontmatter {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    try {
      return (yaml.load(match[1]) as SkillFrontmatter) ?? {};
    } catch {
      return {};
    }
  }

  private parseScopeYaml(path: string): ScopeContract | null {
    try {
      const content = readFileSync(path, 'utf-8');
      return (yaml.load(content) as ScopeContract) ?? null;
    } catch {
      return null;
    }
  }

  private getInstallCounts(): Map<string, number> {
    if (this.installCountsCache) return this.installCountsCache;

    const counts = new Map<string, number>();
    if (!existsSync(this.installCountsPath)) return counts;

    try {
      const data = JSON.parse(readFileSync(this.installCountsPath, 'utf-8'));
      if (Array.isArray(data.counts)) {
        for (const entry of data.counts) {
          if (entry.plugin && typeof entry.unique_installs === 'number') {
            counts.set(entry.plugin, entry.unique_installs);
          }
        }
      }
    } catch (err) {
      console.log('[marketplace] Failed to read install counts:', err);
    }

    this.installCountsCache = counts;
    return counts;
  }

  private readSettings(): Record<string, unknown> & { enabledPlugins: Record<string, boolean> } {
    if (!existsSync(this.settingsPath)) {
      return { enabledPlugins: {} };
    }
    try {
      const data = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
      if (!data.enabledPlugins) data.enabledPlugins = {};
      return data;
    } catch {
      return { enabledPlugins: {} };
    }
  }

  private writeSettings(settings: Record<string, unknown>): void {
    writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
}

/** Quote a single argv token for a /bin/sh command line */
function shellQuote(token: string): string {
  if (token.length === 0) return "''";
  if (/^[a-zA-Z0-9_./:@+=-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
