import express from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { ConfigService } from './config.js';
import { ProjectScanner } from './scanner.js';
import { StreamProcessManager } from './stream-process.js';
import { WorktreeManager } from './worktree-manager.js';
import { TaskStore } from './task-store.js';
import { createRoutes } from './routes.js';
import { setupStreamSocketHandlers } from './stream-socket.js';
import { MarketplaceService } from './marketplace.js';
import { RtkService } from './rtk-service.js';
import { ShellTerminalService, setupShellTerminalHandlers } from './shell-terminal.js';

export interface ServerHandle {
  httpServer: HttpServer;
  port: number;
  shutdown: () => Promise<void>;
}

export async function startServer(options?: { port?: number; staticDir?: string }): Promise<ServerHandle> {
  // Init services
  const configService = new ConfigService();
  const config = await configService.load();

  const PORT = options?.port ?? parseInt(process.env.PORT ?? String(config.port), 10);

  const scanner = new ProjectScanner(configService);
  const taskStore = new TaskStore();
  const streamProcess = new StreamProcessManager(config, taskStore);
  const worktreeManager = new WorktreeManager();

  // Express + Socket.io setup
  const app = express();
  const httpServer = createServer(app);

  // In Electron mode (staticDir provided), allow same-origin only
  // In dev mode, allow Vite dev server origins
  const allowedOrigins = options?.staticDir
    ? []
    : ['http://localhost:5173', 'http://localhost:5174'];

  const io = new Server(httpServer, {
    cors: allowedOrigins.length > 0
      ? { origin: allowedOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'] }
      : undefined,
  });

  if (allowedOrigins.length > 0) {
    app.use(cors({ origin: allowedOrigins }));
  }
  app.use(express.json({ limit: '50mb' }));

  // Services
  const marketplace = new MarketplaceService();
  const rtkService = new RtkService();

  // Wire plugin discovery into the stream process manager
  streamProcess.setPluginPathsProvider(() => marketplace.getInstalledPluginPaths());

  // When a plugin is installed or uninstalled:
  //   1. Push `/reload-plugins` into every idle live conversation so Claude Code
  //      picks up the new plugin modules (tools, skills) in-session.
  //   2. Re-prefetch slash commands per active cwd and broadcast them via
  //      `chat:session` so the `/` autocomplete updates immediately.
  // Both run in the background — the install HTTP response has already returned.
  marketplace.on('changed', (detail: { reason?: string } = {}) => {
    if (detail.reason !== 'installed' && detail.reason !== 'uninstalled') return;

    const ids = streamProcess.reloadPluginsInAllActive();
    if (ids.length > 0) {
      console.log(`[server] Reloaded plugins in ${ids.length} active task(s) after ${detail.reason}`);
    }

    streamProcess.refreshSlashCommandsForAllActive().catch(err => {
      console.log('[server] Slash command refresh after marketplace change failed:', err);
    });
  });


  // Routes
  const routes = createRoutes(configService, scanner, streamProcess, worktreeManager, taskStore, marketplace, rtkService);
  app.use(routes);

  // Serve static frontend files in production/Electron mode
  if (options?.staticDir) {
    app.use(express.static(options.staticDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
  }

  // Shell terminal service
  const shellTerminal = new ShellTerminalService();

  // WebSocket
  setupStreamSocketHandlers(io, streamProcess, taskStore, marketplace);
  setupShellTerminalHandlers(io, shellTerminal);

  // Initial project scan
  scanner.scan().catch(err => {
    console.log('[server] Initial scan failed:', err);
  });

  // Sweep orphaned upload directories: any dir whose id is not in the
  // task store (task was deleted while server was down) or whose mtime
  // is older than 30 days (failsafe against unbounded growth).
  try {
    const uploadsRoot = path.join(homedir(), '.claude-dashboard', 'uploads');
    if (existsSync(uploadsRoot)) {
      const knownIds = new Set(taskStore.getAll().map(t => t.id));
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      let removed = 0;
      for (const entry of readdirSync(uploadsRoot)) {
        const entryPath = path.join(uploadsRoot, entry);
        try {
          const st = statSync(entryPath);
          if (!st.isDirectory()) continue;
          const isOrphan = !knownIds.has(entry);
          const isStale = now - st.mtimeMs > MAX_AGE_MS;
          if (isOrphan || isStale) {
            rmSync(entryPath, { recursive: true, force: true });
            removed++;
          }
        } catch { /* ignore individual failures */ }
      }
      if (removed > 0) console.log(`[server] Cleaned up ${removed} orphaned upload dir(s)`);
    }
  } catch (err) {
    console.log('[server] Upload sweep failed (non-fatal):', err);
  }

  // Pre-fetch slash commands in background, then migrate any legacy
  // task.model values (resolved SDK names) to null so they get re-chosen
  // from the current alias list on next open.
  streamProcess.prefetchSlashCommands()
    .then(() => {
      const validAliases = streamProcess.getCachedSupportedModels().map(m => m.value);
      return taskStore.migrateInvalidModels(validAliases);
    })
    .catch(err => {
      console.log('[server] Slash command prefetch or model migration failed:', err);
    });

  // Auto-resume tasks that were active before the restart
  const activeTasks = taskStore.getActive();
  if (activeTasks.length > 0) {
    console.log(`[server] Resuming ${activeTasks.length} previously active task(s)...`);
    for (const task of activeTasks) {
      const cwd = task.worktreePath ?? task.projectPath;
      if (!existsSync(cwd)) {
        console.log(`[server] Skipping task ${task.id} — path no longer exists: ${cwd}`);
        taskStore.markExited(task.id).catch(() => {});
        continue;
      }
      try {
        const instance = await streamProcess.createInstance({
          id: task.id,
          projectPath: task.projectPath,
          taskDescription: task.taskDescription ?? undefined,
          worktreePath: task.worktreePath ?? undefined,
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
        console.log(`[server] Resumed task: ${task.taskDescription ?? task.projectName} (${instance.id})`);
      } catch (err) {
        console.log(`[server] Failed to resume task ${task.id}:`, err);
        taskStore.markExited(task.id).catch(() => {});
      }
    }
  }

  // Track open sockets so we can force-close them on shutdown
  // (otherwise keep-alive + socket.io connections keep the port bound)
  const openSockets = new Set<import('net').Socket>();
  httpServer.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] Shutting down${signal ? ` (${signal})` : ''}...`);

    // Hard deadline — never hang longer than 5s
    const forceExit = setTimeout(() => {
      console.log('[server] Forced exit after timeout');
      process.exit(1);
    }, 5000);
    forceExit.unref();

    try {
      shellTerminal.destroyAll();
      await streamProcess.shutdownAll();

      // Stop accepting new connections and close socket.io
      io.close();

      // Force-destroy lingering sockets so close() can actually return
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();

      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    } catch (err) {
      console.log('[server] Error during shutdown:', err);
    }

    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { shutdown('SIGHUP'); });
  process.on('uncaughtException', (err) => {
    console.error('[server] Uncaught exception:', err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    console.error('[server] Unhandled rejection:', err);
  });

  // RTK status check
  const rtkStatus = rtkService.getStatus();
  if (rtkStatus.installed) {
    console.log(`[server] RTK ${rtkStatus.version} detected, hooks: ${rtkStatus.hooksInstalled ? 'active' : 'not configured'}`);
  } else {
    console.log('[server] RTK not installed — token compression unavailable');
  }

  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[server] Port ${PORT} is already in use. Another backend is likely still running.`);
        console.error('[server] Run:  lsof -iTCP:' + PORT + ' -sTCP:LISTEN   to find it, then kill the PID.');
      } else {
        console.error('[server] Listen error:', err);
      }
      process.exit(1);
    };
    httpServer.once('error', onError);
    httpServer.listen(PORT, () => {
      httpServer.off('error', onError);
      const actualPort = (httpServer.address() as { port: number }).port;
      console.log(`[server] Claude Dashboard backend running on http://localhost:${actualPort}`);
      resolve({ httpServer, port: actualPort, shutdown });
    });
    void reject;
  });
}

// Run standalone when executed directly (not imported by Electron)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/index.ts') ||
  process.argv[1].endsWith('/index.js') ||
  process.argv[1].includes('packages/backend')
);

if (isMainModule) {
  const staticDir = process.env.STATIC_DIR || undefined;
  startServer({ staticDir }).catch(err => {
    console.error('[server] Fatal error:', err);
    process.exit(1);
  });
}
