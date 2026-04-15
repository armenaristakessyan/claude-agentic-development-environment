import express from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { existsSync } from 'fs';
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
  setupStreamSocketHandlers(io, streamProcess, taskStore);
  setupShellTerminalHandlers(io, shellTerminal);

  // Initial project scan
  scanner.scan().catch(err => {
    console.log('[server] Initial scan failed:', err);
  });

  // Pre-fetch slash commands in background
  streamProcess.prefetchSlashCommands().catch(err => {
    console.log('[server] Slash command prefetch failed:', err);
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
        });
        // Replace old task entry with new instance
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
          createdAt: task.createdAt,
        });
        await taskStore.removeTask(task.id);
        console.log(`[server] Resumed task: ${task.taskDescription ?? task.projectName} (${instance.id})`);
      } catch (err) {
        console.log(`[server] Failed to resume task ${task.id}:`, err);
        taskStore.markExited(task.id).catch(() => {});
      }
    }
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('[server] Shutting down...');
    shellTerminal.destroyAll();
    await streamProcess.shutdownAll();
    httpServer.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // RTK status check
  const rtkStatus = rtkService.getStatus();
  if (rtkStatus.installed) {
    console.log(`[server] RTK ${rtkStatus.version} detected, hooks: ${rtkStatus.hooksInstalled ? 'active' : 'not configured'}`);
  } else {
    console.log('[server] RTK not installed — token compression unavailable');
  }

  return new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      const actualPort = (httpServer.address() as { port: number }).port;
      console.log(`[server] Claude Dashboard backend running on http://localhost:${actualPort}`);
      resolve({ httpServer, port: actualPort, shutdown });
    });
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
