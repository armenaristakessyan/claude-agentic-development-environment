import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type * as NodePty from 'node-pty';
import type { Server, Socket } from 'socket.io';

// ---------------------------------------------------------------------------
// Shell Terminal Service — standalone shell PTYs (not tied to Claude instances)
// ---------------------------------------------------------------------------

const esmRequire = createRequire(import.meta.url);

// On macOS, AMFI rejects posix_spawn(POSIX_SPAWN_CLOEXEC_DEFAULT) on
// spawn-helper when it sits inside a sealed .app bundle — even with a valid
// signature. When ADE_NATIVE_CACHE_DIR is set (packaged Electron), mirror
// node-pty to that writable dir and load from there.
function resolvePtyModule(): typeof NodePty {
  const cacheDir = process.env.ADE_NATIVE_CACHE_DIR;
  if (!cacheDir) {
    return esmRequire('node-pty') as typeof NodePty;
  }
  const sourcePkg = esmRequire.resolve('node-pty/package.json');
  const sourceDir = path.dirname(sourcePkg);
  const { version } = esmRequire(sourcePkg) as { version: string };
  const targetDir = path.join(cacheDir, 'node-pty');
  const stampPath = path.join(cacheDir, 'node-pty.stamp');
  const stamp = `${version}:${fs.statSync(sourcePkg).mtimeMs}`;
  let stale = true;
  try { stale = fs.readFileSync(stampPath, 'utf-8') !== stamp; } catch { /* missing = stale */ }
  if (stale) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    const archDir = path.join(targetDir, 'prebuilds', `${process.platform}-${process.arch}`);
    if (fs.existsSync(archDir)) {
      for (const f of fs.readdirSync(archDir)) {
        if (f === 'spawn-helper' || f.endsWith('.node')) {
          fs.chmodSync(path.join(archDir, f), 0o755);
        }
      }
    }
    fs.writeFileSync(stampPath, stamp);
    console.log(`[shell-terminal] Mirrored node-pty ${version} → ${targetDir}`);
  }
  return esmRequire(path.join(targetDir, 'lib', 'index.js')) as typeof NodePty;
}

const pty = resolvePtyModule();

interface ShellSession {
  id: string;
  pty: NodePty.IPty;
  cwd: string;
  buffer: string;
  clients: Set<string>; // socket IDs attached
}

const MAX_BUFFER = 256 * 1024; // 256KB scrollback

function resolveShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  // Electron launched from Finder may not have SHELL set
  const candidates = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* skip */ }
  }
  return '/bin/zsh';
}

function buildShellEnv(): Record<string, string> {
  // Filter out undefined values — process.env can have them and
  // node-pty passes env to posix_spawnp which requires real strings.
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) {
      env[key] = val;
    }
  }
  // Ensure standard paths exist (Electron from Finder has minimal PATH)
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const currentPath = env.PATH ?? '';
  const pathParts = currentPath.split(':').filter(Boolean);
  for (const p of extraPaths) {
    if (!pathParts.includes(p)) {
      pathParts.push(p);
    }
  }
  env.PATH = pathParts.join(':');
  env.HOME = env.HOME ?? os.homedir();
  env.SHELL = resolveShell();
  env.COLORTERM = 'truecolor';
  env.TERM = 'xterm-256color';
  return env;
}

export class ShellTerminalService extends EventEmitter {
  private sessions = new Map<string, ShellSession>();

  create(cwd?: string): ShellSession {
    const id = randomUUID();
    const shell = resolveShell();
    const env = buildShellEnv();
    const home = os.homedir();
    // Validate cwd exists, fall back to home directory
    let resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : home;
    if (!fs.existsSync(resolvedCwd)) resolvedCwd = '/tmp';

    console.log(`[shell-terminal] Spawning shell=${shell} cwd=${resolvedCwd} PATH=${env.PATH}`);

    // Verify shell binary is accessible before attempting spawn
    try {
      fs.accessSync(shell, fs.constants.X_OK);
    } catch {
      console.error(`[shell-terminal] Shell binary not executable: ${shell}`);
    }

    let ptyProcess: NodePty.IPty;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: resolvedCwd,
        env,
      });
    } catch (err) {
      console.error(`[shell-terminal] pty.spawn failed: shell=${shell} cwd=${resolvedCwd}`, err);
      throw err;
    }

    const session: ShellSession = {
      id,
      pty: ptyProcess,
      cwd: resolvedCwd,
      buffer: '',
      clients: new Set(),
    };

    ptyProcess.onData((data: string) => {
      session.buffer += data;
      if (session.buffer.length > MAX_BUFFER) {
        session.buffer = session.buffer.slice(-MAX_BUFFER);
      }
      this.emit('output', id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.emit('exit', id, exitCode);
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);
    console.log(`[shell-terminal] Created session ${id} in ${resolvedCwd}`);
    return session;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? '';
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.kill();
      this.sessions.delete(id);
      console.log(`[shell-terminal] Destroyed session ${id}`);
    }
  }

  get(id: string): ShellSession | undefined {
    return this.sessions.get(id);
  }

  list(): Array<{ id: string; cwd: string }> {
    return Array.from(this.sessions.values()).map(s => ({ id: s.id, cwd: s.cwd }));
  }

  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroy(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Socket.io handlers
// ---------------------------------------------------------------------------

export function setupShellTerminalHandlers(io: Server, service: ShellTerminalService): void {
  // Forward output to all clients in the session room
  service.on('output', (sessionId: string, data: string) => {
    io.to(`shell:${sessionId}`).emit('shell:output', { sessionId, data });
  });

  service.on('exit', (sessionId: string, exitCode: number) => {
    io.to(`shell:${sessionId}`).emit('shell:exit', { sessionId, exitCode });
  });

  io.on('connection', (socket: Socket) => {
    // Create a new shell session
    socket.on('shell:create', ({ cwd }: { cwd?: string }) => {
      try {
        const session = service.create(cwd);
        socket.join(`shell:${session.id}`);
        session.clients.add(socket.id);
        socket.emit('shell:created', { sessionId: session.id });
      } catch (err) {
        console.log('[shell-terminal] Failed to create session:', err);
        socket.emit('shell:created', { error: err instanceof Error ? err.message : 'Failed to create shell' });
      }
    });

    // Attach to an existing session
    socket.on('shell:attach', ({ sessionId }: { sessionId: string }) => {
      const session = service.get(sessionId);
      if (!session) return;
      socket.join(`shell:${sessionId}`);
      session.clients.add(socket.id);
      // Send buffer history
      const buffer = service.getBuffer(sessionId);
      if (buffer.length > 0) {
        socket.emit('shell:output', { sessionId, data: buffer });
      }
    });

    // Detach from session
    socket.on('shell:detach', ({ sessionId }: { sessionId: string }) => {
      socket.leave(`shell:${sessionId}`);
      const session = service.get(sessionId);
      if (session) {
        session.clients.delete(socket.id);
      }
    });

    // Input from client
    socket.on('shell:input', ({ sessionId, data }: { sessionId: string; data: string }) => {
      service.write(sessionId, data);
    });

    // Resize
    socket.on('shell:resize', ({ sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
      service.resize(sessionId, cols, rows);
    });

    // Destroy session
    socket.on('shell:destroy', ({ sessionId }: { sessionId: string }) => {
      service.destroy(sessionId);
    });

    // List sessions
    socket.on('shell:list', (callback?: (res: { sessions: Array<{ id: string; cwd: string }> }) => void) => {
      if (callback) callback({ sessions: service.list() });
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      for (const session of service.list()) {
        const s = service.get(session.id);
        if (s) {
          s.clients.delete(socket.id);
        }
      }
    });
  });
}
