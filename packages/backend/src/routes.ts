import { Router } from 'express';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, relative } from 'node:path';
import { execSync } from 'node:child_process';
import type { ConfigService } from './config.js';
import type { ProjectScanner } from './scanner.js';
import type { StreamProcessManager } from './stream-process.js';
import type { WorktreeManager } from './worktree-manager.js';
import type { TaskStore } from './task-store.js';
import type { MarketplaceService } from './marketplace.js';

export function createRoutes(
  configService: ConfigService,
  scanner: ProjectScanner,
  processManager: StreamProcessManager,
  worktreeManager: WorktreeManager,
  taskStore: TaskStore,
  marketplace: MarketplaceService,
): Router {
  const router = Router();

  // Health
  router.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Config
  router.get('/api/config', async (_req, res) => {
    try {
      const config = await configService.get();
      res.json(config);
    } catch (err) {
      console.log('[routes] Error reading config:', err);
      res.status(500).json({ error: 'Failed to read config' });
    }
  });

  router.put('/api/config', async (req, res) => {
    try {
      const updated = await configService.save(req.body);
      res.json(updated);
    } catch (err) {
      console.log('[routes] Error saving config:', err);
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  // Projects
  router.get('/api/projects', async (_req, res) => {
    try {
      const projects = await scanner.scan();
      res.json(projects);
    } catch (err) {
      console.log('[routes] Error scanning projects:', err);
      res.status(500).json({ error: 'Failed to scan projects' });
    }
  });

  router.post('/api/projects/refresh', async (_req, res) => {
    try {
      const projects = await scanner.refresh();
      res.json(projects);
    } catch (err) {
      console.log('[routes] Error refreshing projects:', err);
      res.status(500).json({ error: 'Failed to refresh projects' });
    }
  });

  // Instances
  router.get('/api/instances', (_req, res) => {
    const instances = processManager.getAll();
    res.json(instances);
  });

  // Get messages for an instance
  router.get('/api/instances/:id/messages', (req, res) => {
    const messages = processManager.getMessages(req.params.id);
    res.json(messages);
  });

  // Send a message to an instance
  router.post('/api/instances/:id/messages', async (req, res) => {
    const { prompt, model, permissionMode, effort, context, hidden } = req.body as {
      prompt?: string;
      model?: string;
      permissionMode?: string;
      effort?: string;
      context?: { type: string; label: string; value: string }[];
      hidden?: boolean;
    };
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    try {
      await processManager.sendMessage(req.params.id, prompt, { model, permissionMode, effort, context, hidden });
      // Persist settings used for this message
      if (effort || permissionMode || model) {
        taskStore.updateSettings(req.params.id, { effort: effort ?? undefined, permissionMode: permissionMode ?? undefined, model: model ?? undefined }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      res.status(500).json({ error: message });
    }
  });

  router.post('/api/instances', async (req, res) => {
    const { projectPath, taskDescription } = req.body as { projectPath?: string; taskDescription?: string };
    if (!projectPath) {
      res.status(400).json({ error: 'projectPath is required' });
      return;
    }

    try {
      let worktreePath: string | undefined;
      let branchName: string | undefined;
      let parentProjectPath: string | undefined;

      if (taskDescription && worktreeManager.isGitRepo(projectPath)) {
        const result = worktreeManager.createWorktree(projectPath, taskDescription);
        worktreePath = result.worktreePath;
        branchName = result.branchName;
        parentProjectPath = projectPath;

        // Fire-and-forget scanner refresh after worktree creation
        scanner.refresh().catch(err => {
          console.log('[routes] Background scanner refresh failed:', err);
        });
      } else if (worktreeManager.isWorktree(projectPath)) {
        // Launching a pre-existing worktree — populate worktree fields for context + cleanup
        worktreePath = projectPath;
        branchName = worktreeManager.getGitBranch(projectPath) ?? undefined;
        parentProjectPath = worktreeManager.getParentProjectPath(projectPath) ?? undefined;
      }

      const instance = await processManager.createInstance({
        projectPath,
        taskDescription,
        worktreePath,
        parentProjectPath,
        branchName,
      });

      // Persist task to disk
      await taskStore.addTask({
        id: instance.id,
        projectPath: instance.projectPath,
        projectName: instance.projectName,
        taskDescription: instance.taskDescription,
        worktreePath: instance.worktreePath,
        parentProjectPath: instance.parentProjectPath,
        branchName: instance.branchName,
        sessionId: null,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        model: null,
        effort: null,
        permissionMode: null,
        createdAt: instance.createdAt.toISOString(),
      });

      res.status(201).json(instance);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn instance';
      console.log('[routes] Error spawning instance:', err);
      res.status(500).json({ error: message });
    }
  });

  router.delete('/api/instances/:id', async (req, res) => {
    const deleteWorktree = req.query.deleteWorktree === 'true';

    try {
      const instance = processManager.get(req.params.id);
      await processManager.kill(req.params.id);

      // Mark task as exited in store
      await taskStore.markExited(req.params.id);

      if (deleteWorktree && instance?.worktreePath && instance?.parentProjectPath) {
        try {
          worktreeManager.removeWorktree(instance.parentProjectPath, instance.worktreePath);
          scanner.refresh().catch(err => {
            console.log('[routes] Background scanner refresh failed:', err);
          });
        } catch (err) {
          console.log('[routes] Worktree cleanup failed (non-fatal):', err);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to kill instance';
      console.log('[routes] Error killing instance:', err);
      res.status(404).json({ error: message });
    }
  });

  // --- Context API for the + button ---

  // Helper to get cwd for an instance
  function getInstanceCwd(instanceId: string): string | null {
    const instance = processManager.get(instanceId);
    if (!instance) return null;
    return instance.worktreePath ?? instance.projectPath;
  }

  // List files in the project (git-tracked or fallback to fs)
  router.get('/api/instances/:id/context/files', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    try {
      // Use git ls-files if available, else fallback to fs
      const output = execSync('git ls-files --cached --others --exclude-standard', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const files = output.trim().split('\n').filter(Boolean).slice(0, 500);
      res.json({ files, cwd });
    } catch {
      // Fallback: list top-level files
      try {
        const entries = readdirSync(cwd, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.'))
          .map(e => ({ name: e.name, isDir: e.isDirectory() }));
        res.json({ files: entries.map(e => e.name), cwd });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list files';
        res.status(500).json({ error: message });
      }
    }
  });

  // Get file content
  router.post('/api/instances/:id/context/file-content', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    const { filePath } = req.body as { filePath?: string };
    if (!filePath) { res.status(400).json({ error: 'filePath is required' }); return; }

    try {
      const fullPath = join(cwd, filePath);
      // Security: ensure path is within cwd
      if (!fullPath.startsWith(cwd)) {
        res.status(403).json({ error: 'Path outside project' });
        return;
      }
      const content = readFileSync(fullPath, 'utf-8');
      // Limit to 50KB
      const truncated = content.length > 50_000 ? content.slice(0, 50_000) + '\n... (truncated)' : content;
      res.json({ path: filePath, content: truncated });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file';
      res.status(500).json({ error: message });
    }
  });

  // Git branches
  router.get('/api/instances/:id/context/branches', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    try {
      const output = execSync('git branch -a --sort=-committerdate --format="%(refname:short)\t%(committerdate:relative)\t%(subject)"', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const branches = output.trim().split('\n').filter(Boolean).slice(0, 50).map(line => {
        const [name, date, ...subjectParts] = line.split('\t');
        return { name, date, subject: subjectParts.join('\t') };
      });
      res.json({ branches });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Not a git repository';
      res.status(500).json({ error: message });
    }
  });

  // Git commits (recent)
  router.get('/api/instances/:id/context/commits', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    try {
      const output = execSync('git log --oneline --format="%h\t%s\t%cr\t%an" -30', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const commits = output.trim().split('\n').filter(Boolean).map(line => {
        const [hash, subject, date, author] = line.split('\t');
        return { hash, subject, date, author };
      });
      res.json({ commits });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Not a git repository';
      res.status(500).json({ error: message });
    }
  });

  // Local changes (git status + diff)
  router.get('/api/instances/:id/context/changes', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    try {
      const statusOutput = execSync('git status --porcelain', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      // git status --porcelain format: "XY filename" where XY is 2-char status, then space, then path
      // Some statuses use the full 2 chars (e.g. "M ", " M", "??", "MM") so path always starts after char 2
      const files = statusOutput.trim().split('\n').filter(Boolean).map(line => {
        const status = line.slice(0, 2).trim();
        // Path starts after the 2-char status + 1 space separator
        const path = line.charAt(2) === ' ' ? line.slice(3) : line.slice(2).trimStart();
        return { status, path };
      });
      const diffOutput = execSync('git diff --stat', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      res.json({ files, diffSummary: diffOutput.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Not a git repository';
      res.status(500).json({ error: message });
    }
  });

  // File diff for a specific file
  router.post('/api/instances/:id/context/diff', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    const { filePath } = req.body as { filePath?: string };
    if (!filePath) { res.status(400).json({ error: 'filePath is required' }); return; }

    try {
      // Try tracked file diff first, then untracked
      let diff = '';
      try {
        diff = execSync(`git diff -- "${filePath}"`, { cwd, encoding: 'utf-8', timeout: 5000 });
      } catch { /* not tracked */ }
      if (!diff) {
        try {
          diff = execSync(`git diff --cached -- "${filePath}"`, { cwd, encoding: 'utf-8', timeout: 5000 });
        } catch { /* not staged */ }
      }
      if (!diff) {
        // Untracked file — show full content as addition
        const fullPath = join(cwd, filePath);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf-8').slice(0, 30_000);
          diff = `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n` +
            content.split('\n').map(l => `+${l}`).join('\n');
        }
      }
      res.json({ diff: diff.slice(0, 50_000) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get diff';
      res.status(500).json({ error: message });
    }
  });

  // Revert a file to its last committed state
  router.post('/api/instances/:id/context/revert', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    const { filePath } = req.body as { filePath?: string };
    if (!filePath) { res.status(400).json({ error: 'filePath is required' }); return; }

    try {
      // Check if file is untracked
      const status = execSync(`git status --porcelain -- "${filePath}"`, { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
      if (status.startsWith('??')) {
        // Untracked file — delete it
        const fullPath = join(cwd, filePath);
        if (existsSync(fullPath)) {
          const { unlinkSync } = require('node:fs');
          unlinkSync(fullPath);
        }
      } else {
        // Tracked file — restore from HEAD
        execSync(`git checkout HEAD -- "${filePath}"`, { cwd, encoding: 'utf-8', timeout: 5000 });
      }
      console.log(`[routes] Reverted file: ${filePath} in ${cwd}`);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to revert file';
      console.error(`[routes] Revert failed for ${filePath}:`, message);
      res.status(500).json({ error: message });
    }
  });

  // Task history — enrich with worktreeExists flag
  router.get('/api/tasks', (_req, res) => {
    const tasks = taskStore.getAll().map(t => ({
      ...t,
      worktreeExists: t.worktreePath ? existsSync(t.worktreePath) : false,
    }));
    res.json(tasks);
  });

  router.delete('/api/tasks/:id', async (req, res) => {
    try {
      await taskStore.removeMessages(req.params.id);
      await taskStore.removeTask(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.log('[routes] Error removing task:', err);
      res.status(500).json({ error: 'Failed to remove task' });
    }
  });

  // Orphaned worktrees — tasks that exited but worktree still on disk
  router.get('/api/tasks/orphaned', (_req, res) => {
    const activeIds = new Set(processManager.getAll().map(i => i.id));
    res.json(taskStore.getOrphaned(activeIds));
  });

  // Resume an orphaned task — spawn a new Claude instance in the existing worktree
  router.post('/api/tasks/:id/resume', async (req, res) => {
    const tasks = taskStore.getAll();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task || !task.worktreePath) {
      res.status(404).json({ error: 'Task not found or has no worktree' });
      return;
    }

    if (!existsSync(task.worktreePath)) {
      res.status(410).json({ error: 'Worktree no longer exists on disk' });
      return;
    }

    try {
      const instance = await processManager.createInstance({
        projectPath: task.worktreePath,
        taskDescription: task.taskDescription ?? undefined,
        worktreePath: task.worktreePath,
        parentProjectPath: task.parentProjectPath ?? undefined,
        branchName: task.branchName ?? undefined,
        continueSession: true,
        sessionId: task.sessionId ?? undefined,
        totalCostUsd: task.totalCostUsd ?? 0,
        totalInputTokens: task.totalInputTokens ?? 0,
        totalOutputTokens: task.totalOutputTokens ?? 0,
        model: task.model ?? undefined,
        effort: task.effort ?? undefined,
        permissionMode: task.permissionMode ?? undefined,
      });

      // Copy messages from old task to new task before removing old one
      const oldMessages = taskStore.loadMessages(task.id);
      if (oldMessages.length > 0) {
        await taskStore.saveMessages(instance.id, oldMessages);
      }

      // Update task store with the new instance ID
      await taskStore.addTask({
        id: instance.id,
        projectPath: task.projectPath,
        projectName: task.projectName,
        taskDescription: task.taskDescription,
        worktreePath: task.worktreePath,
        parentProjectPath: task.parentProjectPath,
        branchName: task.branchName,
        sessionId: task.sessionId,
        totalCostUsd: task.totalCostUsd ?? 0,
        totalInputTokens: task.totalInputTokens ?? 0,
        totalOutputTokens: task.totalOutputTokens ?? 0,
        model: task.model ?? null,
        effort: task.effort ?? null,
        permissionMode: task.permissionMode ?? null,
        createdAt: new Date().toISOString(),
      });

      // Remove the old task entry + its messages file
      await taskStore.removeMessages(task.id);
      await taskStore.removeTask(task.id);

      res.status(201).json(instance);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume task';
      console.log('[routes] Error resuming task:', err);
      res.status(500).json({ error: message });
    }
  });

  // Persist a tool permission to the project's .claude/settings.local.json
  router.post('/api/instances/:id/allow-tool', (req, res) => {
    const { toolName, scope } = req.body as { toolName?: string; scope?: 'session' | 'project' };
    if (!toolName) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }

    // Always approve in session
    processManager.approveTool(req.params.id, toolName);

    if (scope === 'project') {
      const cwd = getInstanceCwd(req.params.id);
      if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

      try {
        const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
        const settingsDir = join(cwd, '.claude');
        const settingsPath = join(settingsDir, 'settings.local.json');

        // Read existing settings
        let settings: { permissions?: { allow?: string[] }; [key: string]: unknown } = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        }

        // Add the tool permission
        if (!settings.permissions) settings.permissions = {};
        if (!settings.permissions.allow) settings.permissions.allow = [];
        const rule = toolName; // e.g. "Edit", "Bash", "Write"
        if (!settings.permissions.allow.includes(rule)) {
          settings.permissions.allow.push(rule);
        }

        // Write back
        if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log(`[routes] Persisted tool permission '${toolName}' to ${settingsPath}`);
        res.json({ ok: true, persisted: true });
      } catch (err) {
        console.log('[routes] Failed to persist tool permission:', err);
        res.json({ ok: true, persisted: false });
      }
    } else {
      res.json({ ok: true, persisted: false });
    }
  });

  // Worktrees
  router.delete('/api/worktrees', async (req, res) => {
    const { projectPath, worktreePath } = req.body as { projectPath?: string; worktreePath?: string };
    if (!projectPath || !worktreePath) {
      res.status(400).json({ error: 'projectPath and worktreePath are required' });
      return;
    }

    try {
      worktreeManager.removeWorktree(projectPath, worktreePath);
      scanner.refresh().catch(err => {
        console.log('[routes] Background scanner refresh failed:', err);
      });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove worktree';
      console.log('[routes] Error removing worktree:', err);
      res.status(500).json({ error: message });
    }
  });

  // Suggest common project directories that exist on this machine
  router.get('/api/suggest-paths', async (_req, res) => {
    try {
      const home = homedir();
      const candidates = [
        'Developer',
        'Projects',
        'Code',
        'repos',
        'workspace',
        'dev',
        'src',
        'git',
        'GitHub',
        'Documents/Projects',
        'Documents/Code',
        'Documents/Developer',
      ];

      const existing = candidates
        .map(name => join(home, name))
        .filter(p => existsSync(p));

      res.json(existing);
    } catch (err) {
      console.log('[routes] Error suggesting paths:', err);
      res.json([]);
    }
  });

  // Browse directories for folder picker
  router.get('/api/browse', (req, res) => {
    try {
      const requestedPath = (req.query.path as string) || homedir();
      const resolvedPath = requestedPath.startsWith('~')
        ? join(homedir(), requestedPath.slice(1))
        : requestedPath;

      if (!existsSync(resolvedPath)) {
        res.status(404).json({ error: 'Path not found' });
        return;
      }

      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return;
      }

      const entries = readdirSync(resolvedPath, { withFileTypes: true })
        .filter(entry => {
          if (!entry.isDirectory()) return false;
          // Hide hidden dirs except a few useful ones
          if (entry.name.startsWith('.')) return false;
          // Hide system/noisy dirs
          const skip = ['node_modules', '__pycache__', '.git', 'dist', 'build', 'target', 'vendor'];
          if (skip.includes(entry.name)) return false;
          return true;
        })
        .map(entry => ({
          name: entry.name,
          path: join(resolvedPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        current: resolvedPath,
        parent: resolvedPath === '/' ? null : join(resolvedPath, '..'),
        name: basename(resolvedPath),
        entries,
      });
    } catch (err) {
      console.log('[routes] Error browsing directory:', err);
      res.status(500).json({ error: 'Failed to browse directory' });
    }
  });

  // Slash commands (cached from last session init)
  router.get('/api/slash-commands', (_req, res) => {
    res.json(processManager.getSlashCommands());
  });

  // Clear session — resets sessionId, messages, and permissions
  router.post('/api/instances/:id/clear', async (req, res) => {
    try {
      processManager.clearSession(req.params.id);
      // Also clear persisted messages
      await taskStore.saveMessages(req.params.id, []);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear session';
      res.status(500).json({ error: message });
    }
  });

  // --- Marketplace ---

  router.get('/api/marketplace/plugins', (_req, res) => {
    try {
      const marketplaceFilter = _req.query.marketplace as string | undefined;
      const search = _req.query.search as string | undefined;
      const plugins = marketplace.getPlugins(marketplaceFilter, search);
      res.json(plugins);
    } catch (err) {
      console.log('[routes] Error listing marketplace plugins:', err);
      res.status(500).json({ error: 'Failed to list plugins' });
    }
  });

  router.get('/api/marketplace/plugins/:marketplace/:pluginName', (req, res) => {
    try {
      const plugin = marketplace.getPluginDetail(req.params.marketplace, req.params.pluginName);
      if (!plugin) {
        res.status(404).json({ error: 'Plugin not found' });
        return;
      }
      res.json(plugin);
    } catch (err) {
      console.log('[routes] Error getting plugin detail:', err);
      res.status(500).json({ error: 'Failed to get plugin detail' });
    }
  });

  router.get('/api/marketplace/plugins/:marketplace/:pluginName/skills/:skillName', (req, res) => {
    try {
      const skill = marketplace.getSkillDetail(
        req.params.marketplace,
        req.params.pluginName,
        req.params.skillName,
      );
      if (!skill) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      res.json(skill);
    } catch (err) {
      console.log('[routes] Error getting skill detail:', err);
      res.status(500).json({ error: 'Failed to get skill detail' });
    }
  });

  router.post('/api/marketplace/plugins/:marketplace/:pluginName/install', (req, res) => {
    try {
      marketplace.installPlugin(req.params.marketplace, req.params.pluginName);
      res.json({ ok: true });
    } catch (err) {
      console.log('[routes] Error installing plugin:', err);
      res.status(500).json({ error: 'Failed to install plugin' });
    }
  });

  router.post('/api/marketplace/plugins/:marketplace/:pluginName/uninstall', (req, res) => {
    try {
      marketplace.uninstallPlugin(req.params.marketplace, req.params.pluginName);
      res.json({ ok: true });
    } catch (err) {
      console.log('[routes] Error uninstalling plugin:', err);
      res.status(500).json({ error: 'Failed to uninstall plugin' });
    }
  });

  router.post('/api/marketplace/refresh', async (_req, res) => {
    try {
      await marketplace.refresh();
      res.json({ ok: true });
    } catch (err) {
      console.log('[routes] Error refreshing marketplace:', err);
      res.status(500).json({ error: 'Failed to refresh marketplace' });
    }
  });

  router.get('/api/marketplace/installed', (_req, res) => {
    try {
      const installed = marketplace.getInstalledPlugins();
      res.json(installed);
    } catch (err) {
      console.log('[routes] Error listing installed plugins:', err);
      res.status(500).json({ error: 'Failed to list installed plugins' });
    }
  });

  return router;
}
