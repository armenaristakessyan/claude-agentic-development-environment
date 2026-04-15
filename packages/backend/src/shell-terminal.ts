import * as pty from 'node-pty';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { Server, Socket } from 'socket.io';

// ---------------------------------------------------------------------------
// Shell Terminal Service — standalone shell PTYs (not tied to Claude instances)
// ---------------------------------------------------------------------------

interface ShellSession {
  id: string;
  pty: pty.IPty;
  cwd: string;
  buffer: string;
  clients: Set<string>; // socket IDs attached
}

const MAX_BUFFER = 256 * 1024; // 256KB scrollback

function resolveShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  // Electron launched from Finder may not have SHELL set
  const candidates = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  const fs = require('fs') as typeof import('fs');
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* skip */ }
  }
  return '/bin/zsh';
}

function buildShellEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const currentPath = env.PATH ?? '';
  const pathParts = currentPath.split(':');
  for (const p of extraPaths) {
    if (!pathParts.includes(p)) {
      pathParts.unshift(p);
    }
  }
  env.PATH = pathParts.join(':');
  env.SHELL = resolveShell();
  // Force color support
  env.COLORTERM = 'truecolor';
  env.TERM = 'xterm-256color';
  return env;
}

export class ShellTerminalService extends EventEmitter {
  private sessions = new Map<string, ShellSession>();

  create(cwd?: string): ShellSession {
    const id = randomUUID();
    const shell = resolveShell();
    const resolvedCwd = cwd ?? os.homedir();

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: resolvedCwd,
      env: buildShellEnv(),
    });

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
    socket.on('shell:create', ({ cwd }: { cwd?: string }, callback?: (res: { sessionId?: string; error?: string }) => void) => {
      try {
        const session = service.create(cwd);
        socket.join(`shell:${session.id}`);
        session.clients.add(socket.id);
        if (callback) callback({ sessionId: session.id });
      } catch (err) {
        console.log('[shell-terminal] Failed to create session:', err);
        if (callback) callback({ error: err instanceof Error ? err.message : 'Failed to create shell' });
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
