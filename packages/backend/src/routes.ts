import { Router } from 'express';
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, relative } from 'node:path';
import { execSync } from 'node:child_process';
import type { ConfigService } from './config.js';
import type { ProjectScanner } from './scanner.js';
import type { StreamProcessManager } from './stream-process.js';
import type { WorktreeManager } from './worktree-manager.js';
import type { TaskStore } from './task-store.js';
import type { MarketplaceService } from './marketplace.js';
import type { RtkService } from './rtk-service.js';
import type { ProjectIndexService } from './project-index.js';
import { fuzzyScore, fuzzyScoreFilename } from './project-index.js';

export function createRoutes(
  configService: ConfigService,
  scanner: ProjectScanner,
  processManager: StreamProcessManager,
  worktreeManager: WorktreeManager,
  taskStore: TaskStore,
  marketplace: MarketplaceService,
  rtk: RtkService,
  projectIndex: ProjectIndexService,
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
  router.get('/api/instances/:id/messages', async (req, res) => {
    try {
      const messages = await processManager.getSessionHistory(req.params.id);
      res.json(messages);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load messages';
      res.status(500).json({ error: message });
    }
  });

  // Upload a file attachment for an instance. Writes the payload to
  // ~/.claude-dashboard/uploads/<instanceId>/ and returns the absolute
  // path — the frontend then attaches the path (not the content) to
  // the next message so Claude can Read it on demand.
  router.post('/api/instances/:id/upload', async (req, res) => {
    const { filename, dataUrl } = req.body as { filename?: string; dataUrl?: string };
    if (!filename || !dataUrl) {
      res.status(400).json({ error: 'filename and dataUrl are required' });
      return;
    }
    const instance = processManager.get(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    try {
      const uploadsDir = join(homedir(), '.claude-dashboard', 'uploads', req.params.id);
      if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

      // Sanitize: strip path separators + unsafe chars, cap length.
      const safeName = basename(filename).replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'upload';
      const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
      const absPath = join(uploadsDir, unique);

      // Accept either a data URL (`data:<mime>;base64,<b64>`) or a bare base64 string.
      const commaIdx = dataUrl.indexOf(',');
      const b64 = commaIdx >= 0 && dataUrl.startsWith('data:') ? dataUrl.slice(commaIdx + 1) : dataUrl;
      writeFileSync(absPath, Buffer.from(b64, 'base64'));

      res.json({ path: absPath, filename: safeName });
    } catch (err) {
      console.log('[routes] Upload failed:', err);
      const message = err instanceof Error ? err.message : 'Upload failed';
      res.status(500).json({ error: message });
    }
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
    const { projectPath, taskDescription, branchName: customBranch, useWorktree } = req.body as {
      projectPath?: string; taskDescription?: string; branchName?: string; useWorktree?: boolean;
    };
    if (!projectPath) {
      res.status(400).json({ error: 'projectPath is required' });
      return;
    }

    try {
      let worktreePath: string | undefined;
      let branchName: string | undefined;
      let parentProjectPath: string | undefined;

      if (taskDescription && useWorktree !== false && worktreeManager.isGitRepo(projectPath)) {
        const result = worktreeManager.createWorktree(projectPath, taskDescription, customBranch || undefined);
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
        approvedTools: [],
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

  // @ mention picker: files + symbols for the instance's cwd, drawn from the
  // same project index as Quick Open so rankings and coverage match.
  router.get('/api/instances/:id/context/mentions', async (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }
    const query = (req.query.q as string ?? '').trim();
    const FILE_LIMIT = 10;
    const SYMBOL_LIMIT = 10;

    try {
      const [allFiles, allSymbols] = await Promise.all([
        projectIndex.getFiles(cwd),
        projectIndex.getSymbols(cwd),
      ]);

      if (!query) {
        res.json({
          files: allFiles.slice(0, FILE_LIMIT).map(filePath => ({ filePath })),
          symbols: allSymbols.slice(0, SYMBOL_LIMIT),
        });
        return;
      }

      const scoredFiles: { filePath: string; score: number }[] = [];
      for (const filePath of allFiles) {
        const s = fuzzyScoreFilename(query, filePath);
        if (s !== null) scoredFiles.push({ filePath, score: s });
      }
      scoredFiles.sort((a, b) => b.score - a.score);

      const scoredSymbols: { sym: typeof allSymbols[number]; score: number }[] = [];
      for (const sym of allSymbols) {
        const s = fuzzyScore(query, sym.name);
        if (s !== null) scoredSymbols.push({ sym, score: s });
      }
      scoredSymbols.sort((a, b) => b.score - a.score);

      res.json({
        files: scoredFiles.slice(0, FILE_LIMIT).map(({ filePath }) => ({ filePath })),
        symbols: scoredSymbols.slice(0, SYMBOL_LIMIT).map(({ sym }) => sym),
      });
    } catch (err) {
      console.log('[routes] context/mentions failed:', err);
      res.json({ files: [], symbols: [] });
    }
  });

  // Search for symbols (functions, classes, methods) in the project
  router.get('/api/instances/:id/context/symbols', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    const query = (req.query.q as string ?? '').trim();
    if (!query) { res.json({ symbols: [] }); return; }

    try {
      // Use grep to find function/method/class definitions matching the query
      const pattern = `(function|const|let|var|class|interface|type|def|fn|func|pub|export|async)\\s+\\w*${query}\\w*`;
      const output = execSync(
        `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.rs' --include='*.go' --include='*.java' --include='*.rb' --include='*.php' --include='*.swift' --include='*.kt' --include='*.scala' --include='*.c' --include='*.cpp' --include='*.h' -E '${pattern}' . 2>/dev/null || true`,
        { cwd, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 512 },
      );
      const symbols = output.trim().split('\n')
        .filter(Boolean)
        .slice(0, 50)
        .map(line => {
          // Format: ./path/to/file:lineNum:matched line
          const match = line.match(/^\.\/(.+?):(\d+):(.+)$/);
          if (!match) return null;
          const [, filePath, lineNum, text] = match;
          // Extract symbol name from the matched line
          const nameMatch = text.match(/(?:function|const|let|var|class|interface|type|def|fn|func|pub\s+fn|export\s+(?:default\s+)?(?:function|class|const|async\s+function))\s+(\w+)/);
          const name = nameMatch?.[1] ?? text.trim().slice(0, 60);
          return { name, filePath, line: parseInt(lineNum, 10), text: text.trim().slice(0, 120) };
        })
        .filter(Boolean);
      res.json({ symbols });
    } catch {
      res.json({ symbols: [] });
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
      const statusOutput = execSync('git status --porcelain --untracked-files=all', {
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

  // --- Git workflow: commit, push, PR, merge ---

  // Git status summary (uncommitted + unpushed info)
  router.get('/api/instances/:id/git/status', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();

      // Uncommitted changes count
      const statusOutput = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 });
      const uncommittedFiles = statusOutput.trim().split('\n').filter(Boolean).length;

      // Commits ahead of main (unpushed)
      let mainBranch = 'main';
      try {
        // Detect default branch
        const defaultRef = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
        mainBranch = defaultRef.replace('refs/remotes/origin/', '');
      } catch {
        // Try master if main doesn't exist
        try {
          execSync('git rev-parse --verify origin/master', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          mainBranch = 'master';
        } catch { /* keep main */ }
      }

      let commitsAhead = 0;
      let commitMessages: string[] = [];
      try {
        const log = execSync(`git log origin/${mainBranch}..HEAD --oneline`, { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
        const lines = log.split('\n').filter(Boolean);
        commitsAhead = lines.length;
        commitMessages = lines.map(l => l.replace(/^[a-f0-9]+ /, ''));
      } catch { /* no remote or no commits */ }

      // Check if remote tracking branch exists
      let hasRemote = false;
      try {
        execSync(`git rev-parse --verify origin/${branch}`, { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        hasRemote = true;
      } catch { /* not pushed yet */ }

      // Check if there are unpushed commits on current branch
      let unpushedCount = 0;
      if (hasRemote) {
        try {
          const unpushed = execSync(`git log origin/${branch}..HEAD --oneline`, { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
          unpushedCount = unpushed.split('\n').filter(Boolean).length;
        } catch { /* ignore */ }
      } else {
        unpushedCount = commitsAhead;
      }

      res.json({
        branch,
        mainBranch,
        uncommittedFiles,
        commitsAhead,
        commitMessages,
        unpushedCount,
        hasRemote,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get git status';
      res.status(500).json({ error: message });
    }
  });

  // Commit changes
  router.post('/api/instances/:id/git/commit', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    const { message, files } = req.body as { message?: string; files?: string[] };
    if (!message) { res.status(400).json({ error: 'Commit message is required' }); return; }

    try {
      if (files && files.length > 0) {
        // Stage specific files
        for (const file of files) {
          execSync(`git add -- "${file}"`, { cwd, encoding: 'utf-8', timeout: 5000 });
        }
      } else {
        // Stage all changes
        execSync('git add -A', { cwd, encoding: 'utf-8', timeout: 5000 });
      }

      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd,
        encoding: 'utf-8',
        timeout: 15000,
      });

      const hash = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
      console.log(`[routes] Committed ${hash}: ${message}`);
      res.json({ ok: true, hash });
    } catch (err) {
      const message2 = err instanceof Error ? err.message : 'Failed to commit';
      console.error('[routes] Commit failed:', message2);
      res.status(500).json({ error: message2 });
    }
  });

  // Push current branch to remote
  router.post('/api/instances/:id/git/push', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
      execSync(`git push -u origin "${branch}"`, {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
      });
      console.log(`[routes] Pushed branch ${branch}`);
      res.json({ ok: true, branch });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to push';
      console.error('[routes] Push failed:', message);
      res.status(500).json({ error: message });
    }
  });

  // Create pull request via gh CLI
  router.post('/api/instances/:id/git/create-pr', (req, res) => {
    const cwd = getInstanceCwd(req.params.id);
    if (!cwd) { res.status(404).json({ error: 'Instance not found' }); return; }

    const { title, body, baseBranch } = req.body as { title?: string; body?: string; baseBranch?: string };
    if (!title) { res.status(400).json({ error: 'PR title is required' }); return; }

    try {
      // Push first if not already pushed
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
      try {
        execSync(`git push -u origin "${branch}"`, { cwd, encoding: 'utf-8', timeout: 30000 });
      } catch { /* may already be pushed */ }

      // Create PR
      const baseArg = baseBranch ? `--base "${baseBranch}"` : '';
      const bodyArg = body ? `--body "${body.replace(/"/g, '\\"')}"` : '--body ""';
      const output = execSync(
        `gh pr create --title "${title.replace(/"/g, '\\"')}" ${bodyArg} ${baseArg}`,
        { cwd, encoding: 'utf-8', timeout: 30000 },
      );
      const prUrl = output.trim().split('\n').pop() ?? '';
      console.log(`[routes] Created PR: ${prUrl}`);
      res.json({ ok: true, url: prUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create PR';
      console.error('[routes] PR creation failed:', message);
      res.status(500).json({ error: message });
    }
  });

  // Merge worktree branch into main (squash merge)
  router.post('/api/instances/:id/git/merge-to-main', (req, res) => {
    const instance = processManager.get(req.params.id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }

    const parentPath = instance.parentProjectPath ?? instance.projectPath;
    const worktreePath = instance.worktreePath;
    if (!worktreePath) { res.status(400).json({ error: 'Instance is not in a worktree' }); return; }

    const { commitMessage } = req.body as { commitMessage?: string };

    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      // Detect main branch
      let mainBranch = 'main';
      try {
        const defaultRef = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
          cwd: parentPath,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: 'pipe',
        }).trim();
        mainBranch = defaultRef.replace('refs/remotes/origin/', '');
      } catch {
        try {
          execSync('git rev-parse --verify master', { cwd: parentPath, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          mainBranch = 'master';
        } catch { /* keep main */ }
      }

      // Switch to main in the parent repo and squash merge
      execSync(`git checkout ${mainBranch}`, { cwd: parentPath, encoding: 'utf-8', timeout: 10000 });
      execSync(`git merge --squash "${branch}"`, { cwd: parentPath, encoding: 'utf-8', timeout: 15000 });

      const msg = commitMessage ?? `Merge ${branch}`;
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
        cwd: parentPath,
        encoding: 'utf-8',
        timeout: 15000,
      });

      const hash = execSync('git rev-parse --short HEAD', { cwd: parentPath, encoding: 'utf-8', timeout: 5000 }).trim();
      console.log(`[routes] Squash-merged ${branch} into ${mainBranch} (${hash})`);
      res.json({ ok: true, hash, mainBranch });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to merge';
      console.error('[routes] Merge failed:', message);
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
      await taskStore.removeTask(req.params.id);
      // Clean up any uploaded attachments for this task
      const uploadsDir = join(homedir(), '.claude-dashboard', 'uploads', req.params.id);
      if (existsSync(uploadsDir)) {
        try {
          rmSync(uploadsDir, { recursive: true, force: true });
        } catch (err) {
          console.log(`[routes] Failed to remove uploads dir ${uploadsDir}:`, err);
        }
      }
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
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    // Determine the working directory: worktree if it exists, otherwise project path
    const cwd = task.worktreePath && existsSync(task.worktreePath)
      ? task.worktreePath
      : task.projectPath;

    if (!existsSync(cwd)) {
      res.status(410).json({ error: 'Project directory no longer exists on disk' });
      return;
    }

    try {
      const isWorktree = task.worktreePath && existsSync(task.worktreePath);
      const instance = await processManager.createInstance({
        projectPath: isWorktree ? task.worktreePath! : task.projectPath,
        taskDescription: task.taskDescription ?? undefined,
        worktreePath: isWorktree ? task.worktreePath! : undefined,
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
        createdAt: task.createdAt ? new Date(task.createdAt) : undefined,
        approvedTools: task.approvedTools ?? [],
      });

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
        approvedTools: task.approvedTools ?? [],
        createdAt: task.createdAt,
      });

      // Remove the old task entry
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

  // Revoke a previously-approved tool from the per-task allowlist
  router.post('/api/instances/:id/revoke-tool', (req, res) => {
    const { toolName } = req.body as { toolName?: string };
    if (!toolName) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    processManager.revokeTool(req.params.id, toolName);
    res.json({ ok: true });
  });

  // Get pending permission request or user question for an instance
  // (used by frontend after reconnect to recover stalled UI)
  router.get('/api/instances/:id/pending', (req, res) => {
    const instance = processManager.get(req.params.id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }
    res.json(processManager.getPendingState(req.params.id));
  });

  // Resolve a pending permission request via REST — socket-independent path
  // so approvals still work when the websocket has dropped/reset.
  router.post('/api/instances/:id/resolve-permission', (req, res) => {
    const instance = processManager.get(req.params.id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }
    const { toolUseId, allow, message } = req.body as { toolUseId?: string; allow?: boolean; message?: string };
    if (!toolUseId || typeof allow !== 'boolean') {
      res.status(400).json({ error: 'toolUseId and allow are required' });
      return;
    }
    processManager.resolvePermission(req.params.id, toolUseId, allow, message);
    res.json({ ok: true });
  });

  // Resolve a pending AskUserQuestion via REST — same rationale as above.
  router.post('/api/instances/:id/resolve-question', (req, res) => {
    const instance = processManager.get(req.params.id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }
    const { toolUseId, answer } = req.body as { toolUseId?: string; answer?: string };
    if (!toolUseId || typeof answer !== 'string') {
      res.status(400).json({ error: 'toolUseId and answer are required' });
      return;
    }
    processManager.resolveUserQuestion(req.params.id, toolUseId, answer);
    res.json({ ok: true });
  });

  // Read permissions from all scopes for an instance
  router.get('/api/instances/:id/permissions', (req, res) => {
    const instance = processManager.get(req.params.id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }

    const cwd = instance.worktreePath ?? instance.projectPath;
    const claudeDir = join(homedir(), '.claude');

    const readJsonPermissions = (filePath: string): string[] => {
      try {
        if (!existsSync(filePath)) return [];
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        return data?.permissions?.allow ?? [];
      } catch { return []; }
    };

    // Session-level: approved tools in memory for this instance
    const sessionPermissions = [...processManager.getApprovedTools(req.params.id)];

    // Project-level: .claude/settings.local.json in the project
    const projectPermissions = readJsonPermissions(join(cwd, '.claude', 'settings.local.json'));

    // Project shared: .claude/settings.json in the project
    const projectSharedPermissions = readJsonPermissions(join(cwd, '.claude', 'settings.json'));

    // User-level: ~/.claude/settings.local.json
    const userPermissions = readJsonPermissions(join(claudeDir, 'settings.local.json'));

    // Global: ~/.claude/settings.json
    const globalPermissions = readJsonPermissions(join(claudeDir, 'settings.json'));

    res.json({
      session: sessionPermissions,
      project: projectPermissions,
      projectShared: projectSharedPermissions,
      user: userPermissions,
      global: globalPermissions,
    });
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

  // Quick open: fuzzy filename + symbol search backed by an in-memory index
  // built via `git ls-files` + a single `rg` pass. TTL'd with
  // stale-while-revalidate so keystrokes always hit a warm cache.
  router.get('/api/projects/quick-open', async (req, res) => {
    const projectPath = req.query.path as string;
    const mode = (req.query.mode === 'symbols' ? 'symbols' : 'files') as 'files' | 'symbols';
    const query = (req.query.q as string ?? '').trim();
    if (!projectPath || !existsSync(projectPath)) {
      res.status(400).json({ error: 'Valid project path is required' });
      return;
    }

    const LIMIT = 50;
    try {
      if (mode === 'files') {
        const files = await projectIndex.getFiles(projectPath);
        if (!query) {
          res.json({ results: files.slice(0, LIMIT).map(filePath => ({ filePath })) });
          return;
        }
        const scored: { filePath: string; score: number }[] = [];
        for (const filePath of files) {
          const s = fuzzyScoreFilename(query, filePath);
          if (s !== null) scored.push({ filePath, score: s });
        }
        scored.sort((a, b) => b.score - a.score);
        res.json({ results: scored.slice(0, LIMIT).map(({ filePath }) => ({ filePath })) });
        return;
      }

      // symbols
      const symbols = await projectIndex.getSymbols(projectPath);
      if (!query) {
        res.json({ results: symbols.slice(0, LIMIT) });
        return;
      }
      const scored: { sym: typeof symbols[number]; score: number }[] = [];
      for (const sym of symbols) {
        const s = fuzzyScore(query, sym.name);
        if (s !== null) scored.push({ sym, score: s });
      }
      scored.sort((a, b) => b.score - a.score);
      res.json({ results: scored.slice(0, LIMIT).map(({ sym }) => sym) });
    } catch (err) {
      console.log('[routes] quick-open failed:', err);
      res.json({ results: [] });
    }
  });

  // --- Project file browsing (no instance required) ---

  // List files in a project directory (git-tracked or fallback)
  router.get('/api/projects/files', (req, res) => {
    const projectPath = req.query.path as string;
    if (!projectPath || !existsSync(projectPath)) {
      res.status(400).json({ error: 'Valid project path is required' });
      return;
    }

    try {
      let files: string[];
      try {
        const output = execSync('git ls-files --cached --others --exclude-standard', {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 5000,
        });
        files = output.trim().split('\n').filter(Boolean);
      } catch {
        // Fallback: recursive file listing (limited depth)
        files = [];
        const walk = (dir: string, prefix: string, depth: number) => {
          if (depth > 5) return;
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              walk(join(dir, entry.name), rel, depth + 1);
            } else {
              files.push(rel);
            }
          }
        };
        walk(projectPath, '', 0);
      }
      res.json({ files });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list files';
      res.status(500).json({ error: message });
    }
  });

  // Read file content from a project directory
  router.post('/api/projects/file-content', (req, res) => {
    const { projectPath, filePath } = req.body as { projectPath?: string; filePath?: string };
    if (!projectPath || !filePath) {
      res.status(400).json({ error: 'projectPath and filePath are required' });
      return;
    }

    try {
      const fullPath = join(projectPath, filePath);
      // Security: ensure path is within project
      if (!fullPath.startsWith(projectPath)) {
        res.status(403).json({ error: 'Path outside project' });
        return;
      }
      if (!existsSync(fullPath)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Path is a directory' });
        return;
      }
      // Check if binary (simple heuristic)
      const content = readFileSync(fullPath, 'utf-8');
      const truncated = content.length > 100_000 ? content.slice(0, 100_000) + '\n... (truncated)' : content;
      res.json({ path: filePath, content: truncated, size: stat.size });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file';
      res.status(500).json({ error: message });
    }
  });

  // Slash commands (cached from last session init)
  router.get('/api/slash-commands', async (req, res) => {
    if (req.query.refresh) {
      await processManager.prefetchSlashCommands(true);
    }
    res.json(processManager.getSlashCommands());
  });

  // Context usage — token breakdown by category
  router.get('/api/instances/:id/context-usage', async (req, res) => {
    try {
      const usage = await processManager.getContextUsage(req.params.id);
      res.json(usage ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get context usage';
      res.status(500).json({ error: message });
    }
  });

  // Supported models — dynamic from SDK (live conversation)
  router.get('/api/instances/:id/models', async (req, res) => {
    try {
      const models = await processManager.getSupportedModels(req.params.id);
      res.json(models);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get models';
      res.status(500).json({ error: message });
    }
  });

  // Supported models — global cached list (prefetched at startup).
  // If the cache is empty (e.g. right after a backend restart), trigger
  // the prefetch and wait for it so the first call returns real data.
  router.get('/api/models', async (_req, res) => {
    let models = processManager.getCachedSupportedModels();
    if (!models || models.length === 0) {
      try {
        await processManager.prefetchSlashCommands();
        models = processManager.getCachedSupportedModels();
      } catch (err) {
        console.log('[routes] /api/models prefetch failed:', err);
      }
    }
    res.json(models ?? []);
  });

  // Per-task prefetch: one SDK query in the task's cwd returning both
  // slash commands (project-local plugins) and supported models. Cached
  // per-cwd so re-opening a task is instant. Used by the frontend to
  // display a single loader while the chat view warms up.
  router.get('/api/instances/:id/prefetch', async (req, res) => {
    const instance = processManager.get(req.params.id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }
    const cwd = instance.worktreePath ?? instance.projectPath;
    try {
      const result = await processManager.prefetchForCwd(cwd);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Prefetch failed';
      res.status(500).json({ error: message });
    }
  });

  // Update per-instance settings (model / effort / permissionMode)
  router.put('/api/instances/:id/settings', async (req, res) => {
    const { model, effort, permissionMode } = req.body as {
      model?: string;
      effort?: string;
      permissionMode?: string;
    };
    try {
      await processManager.updateSettings(req.params.id, { model, effort, permissionMode });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update settings';
      res.status(404).json({ error: message });
    }
  });

  // Rewind files to a previous message state
  router.post('/api/instances/:id/rewind', async (req, res) => {
    const { userMessageId, dryRun } = req.body as { userMessageId?: string; dryRun?: boolean };
    if (!userMessageId) {
      res.status(400).json({ error: 'userMessageId is required' });
      return;
    }
    try {
      const result = await processManager.rewindFiles(req.params.id, userMessageId, dryRun ?? false);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rewind files';
      res.status(500).json({ error: message });
    }
  });

  // Interrupt — stop the current generation
  router.post('/api/instances/:id/interrupt', (req, res) => {
    try {
      processManager.interrupt(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to interrupt';
      res.status(404).json({ error: message });
    }
  });

  // Clear session — resets sessionId, messages, and permissions
  router.post('/api/instances/:id/clear', async (req, res) => {
    try {
      processManager.clearSession(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear session';
      res.status(500).json({ error: message });
    }
  });

  // --- Marketplace ---

  router.get('/api/marketplace/sources', (_req, res) => {
    try {
      const sources = marketplace.listMarketplaces();
      res.json(sources);
    } catch (err) {
      console.log('[routes] Error listing marketplace sources:', err);
      res.status(500).json({ error: 'Failed to list marketplace sources' });
    }
  });

  router.post('/api/marketplace/add', async (req, res) => {
    try {
      const { repo, autoUpdate } = req.body as { repo?: string; autoUpdate?: boolean };
      if (!repo || typeof repo !== 'string') {
        res.status(400).json({ error: 'Missing or invalid "repo" field. Use owner/repo or a full git URL.' });
        return;
      }
      const result = marketplace.addMarketplace(repo, autoUpdate ?? true);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add marketplace';
      console.log('[routes] Error adding marketplace:', err);
      res.status(500).json({ error: message });
    }
  });

  router.patch('/api/marketplace/:name', (req, res) => {
    try {
      const { autoUpdate } = req.body as { autoUpdate?: boolean };
      if (typeof autoUpdate !== 'boolean') {
        res.status(400).json({ error: 'Missing or invalid "autoUpdate" field' });
        return;
      }
      marketplace.setAutoUpdate(req.params.name, autoUpdate);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update marketplace';
      console.log('[routes] Error updating marketplace:', err);
      res.status(500).json({ error: message });
    }
  });

  router.delete('/api/marketplace/:name', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true';
      marketplace.removeMarketplace(req.params.name, deleteFiles);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove marketplace';
      console.log('[routes] Error removing marketplace:', err);
      res.status(500).json({ error: message });
    }
  });

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
      // MarketplaceService.emit('changed') invalidates the prefetch cache.
      // Next task open lazily re-prefetches — no Claude spawn here.
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

  // --- RTK (Token Compression) ---

  router.get('/api/rtk/status', (_req, res) => {
    try {
      const status = rtk.getStatus();
      res.json(status);
    } catch (err) {
      console.log('[routes] Error getting RTK status:', err);
      res.json({ installed: false, version: null, hooksInstalled: false, hookDetails: 'Error checking status' });
    }
  });

  router.post('/api/rtk/install-hooks', (_req, res) => {
    try {
      const result = rtk.installHooks();
      res.json(result);
    } catch (err) {
      console.log('[routes] Error installing RTK hooks:', err);
      res.status(500).json({ success: false, output: 'Failed to install hooks' });
    }
  });

  router.post('/api/rtk/uninstall-hooks', (_req, res) => {
    try {
      const result = rtk.uninstallHooks();
      res.json(result);
    } catch (err) {
      console.log('[routes] Error uninstalling RTK hooks:', err);
      res.status(500).json({ success: false, output: 'Failed to uninstall hooks' });
    }
  });

  router.get('/api/rtk/stats', (_req, res) => {
    try {
      const stats = rtk.getStats();
      if (!stats) {
        res.status(404).json({ error: 'No RTK stats available' });
        return;
      }
      res.json(stats);
    } catch (err) {
      console.log('[routes] Error getting RTK stats:', err);
      res.status(500).json({ error: 'Failed to get RTK stats' });
    }
  });

  router.get('/api/rtk/graph', (_req, res) => {
    try {
      const graph = rtk.getGraph();
      res.json({ graph: graph ?? '' });
    } catch (err) {
      console.log('[routes] Error getting RTK graph:', err);
      res.status(500).json({ error: 'Failed to get RTK graph' });
    }
  });

  router.get('/api/rtk/history', (_req, res) => {
    try {
      const history = rtk.getHistory();
      res.json({ history: history ?? '' });
    } catch (err) {
      console.log('[routes] Error getting RTK history:', err);
      res.status(500).json({ error: 'Failed to get RTK history' });
    }
  });

  router.get('/api/rtk/discover', (_req, res) => {
    try {
      const output = rtk.discover();
      res.json({ output: output ?? '' });
    } catch (err) {
      console.log('[routes] Error running RTK discover:', err);
      res.status(500).json({ error: 'Failed to run RTK discover' });
    }
  });

  return router;
}
