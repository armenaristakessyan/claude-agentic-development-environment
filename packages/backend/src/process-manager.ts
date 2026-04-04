import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import type { AppConfig } from './config.js';

function resolveClaudeBinary(): string {
  const fs = require('fs') as typeof import('fs');

  // Check well-known locations directly (no shell, no output pollution)
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      console.log(`[process-manager] Resolved claude binary: ${candidate}`);
      return candidate;
    } catch {
      // Not found or not executable
    }
  }

  // Last resort: check PATH entries
  const pathDirs = (process.env.PATH ?? '').split(':');
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      console.log(`[process-manager] Resolved claude binary from PATH: ${candidate}`);
      return candidate;
    } catch {
      // Not found
    }
  }

  console.log('[process-manager] Could not resolve claude binary, falling back to "claude"');
  return 'claude';
}

function buildPtyEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Ensure common user binary paths are in PATH
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

  // Remove all Claude Code env vars so spawned instances
  // don't think they're nested inside another session
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete env[key];
    }
  }

  return env;
}

const INSTANCE_STATUS = {
  LAUNCHING: 'launching',
  PROCESSING: 'processing',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  EXITED: 'exited',
} as const;

type InstanceStatus = typeof INSTANCE_STATUS[keyof typeof INSTANCE_STATUS];

interface Instance {
  id: string;
  projectPath: string;
  projectName: string;
  pid: number;
  status: InstanceStatus;
  createdAt: Date;
  lastActivity: Date;
  taskDescription: string | null;
  worktreePath: string | null;
  parentProjectPath: string | null;
  branchName: string | null;
  lastUserPrompt: string | null;
}

interface SpawnOptions {
  projectPath: string;
  taskDescription?: string;
  worktreePath?: string;
  parentProjectPath?: string;
  branchName?: string;
  continueSession?: boolean;
}

interface PtyHandle {
  process: pty.IPty;
  buffer: string[];
  bufferSize: number;
  instance: Instance;
  inputLineBuffer: string;
}

interface InstanceContext {
  taskDescription: string | null;
  lastUserPrompt: string | null;
}

export class ProcessManager extends EventEmitter {
  private handles = new Map<string, PtyHandle>();
  private readonly MAX_BUFFER_BYTES = 512 * 1024; // 512KB of raw terminal data
  private readonly claudeBinary: string;

  constructor(private config: AppConfig) {
    super();
    this.claudeBinary = resolveClaudeBinary();
  }

  async spawn(options: SpawnOptions): Promise<Instance> {
    if (this.handles.size >= this.config.maxInstances) {
      throw new Error(`Maximum instances reached (${this.config.maxInstances})`);
    }

    const id = randomUUID();
    const cwd = options.worktreePath ?? options.projectPath;
    const projectName = path.basename(options.projectPath);

    // Build a fresh env each time to avoid stale state after tsx watch reloads
    const env = buildPtyEnv();

    const args: string[] = [];
    if (options.continueSession) {
      args.push('--continue');
      console.log(`[process-manager] Spawning ${this.claudeBinary} --continue in ${cwd}`);
    } else {
      console.log(`[process-manager] Spawning ${this.claudeBinary} in ${cwd}`);
    }

    const ptyProcess = pty.spawn(this.claudeBinary, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const instance: Instance = {
      id,
      projectPath: options.projectPath,
      projectName,
      pid: ptyProcess.pid,
      status: INSTANCE_STATUS.LAUNCHING,
      createdAt: new Date(),
      lastActivity: new Date(),
      taskDescription: options.taskDescription ?? null,
      worktreePath: options.worktreePath ?? null,
      parentProjectPath: options.parentProjectPath ?? null,
      branchName: options.branchName ?? null,
      lastUserPrompt: null,
    };

    const handle: PtyHandle = {
      process: ptyProcess,
      buffer: [],
      bufferSize: 0,
      instance,
      inputLineBuffer: '',
    };

    this.handles.set(id, handle);

    ptyProcess.onData((data: string) => {
      handle.instance.lastActivity = new Date();
      this.appendBuffer(handle, data);
      this.emit('output', id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      handle.instance.status = INSTANCE_STATUS.EXITED;
      this.emit('status', id, INSTANCE_STATUS.EXITED);
      this.emit('exited', id, exitCode);
      console.log(`[process-manager] Instance ${id} exited with code ${exitCode}`);
    });

    console.log(`[process-manager] Spawned instance ${id} (pid ${ptyProcess.pid}) for ${cwd}`);
    this.emit('status', id, INSTANCE_STATUS.LAUNCHING);

    return instance;
  }

  async kill(instanceId: string): Promise<void> {
    const handle = this.handles.get(instanceId);
    if (!handle) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Already exited, just clean up the map
    if (handle.instance.status === INSTANCE_STATUS.EXITED) {
      this.handles.delete(instanceId);
      return;
    }

    console.log(`[process-manager] Killing instance ${instanceId}`);

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceKillTimeout);
        clearTimeout(giveUpTimeout);
        this.handles.delete(instanceId);
        resolve();
      };

      // Listen for exit (only once)
      handle.process.onExit(() => done());

      // Send SIGTERM
      try {
        handle.process.kill('SIGTERM');
      } catch {
        done();
        return;
      }

      // SIGKILL after 3s if SIGTERM didn't work
      const forceKillTimeout = setTimeout(() => {
        try {
          handle.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 3000);

      // Give up after 5s no matter what — clean up and move on
      const giveUpTimeout = setTimeout(() => {
        console.log(`[process-manager] Instance ${instanceId} did not exit in 5s, force cleaning up`);
        try {
          process.kill(handle.instance.pid, 'SIGKILL');
        } catch {
          // pid might already be gone
        }
        done();
      }, 5000);
    });
  }

  getAll(): Instance[] {
    return Array.from(this.handles.values()).map(h => ({ ...h.instance }));
  }

  get(instanceId: string): Instance | undefined {
    const handle = this.handles.get(instanceId);
    return handle ? { ...handle.instance } : undefined;
  }

  write(instanceId: string, data: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle || handle.instance.status === INSTANCE_STATUS.EXITED) return;
    this.trackInput(handle, data);
    handle.process.write(data);
  }

  getContext(instanceId: string): InstanceContext | undefined {
    const handle = this.handles.get(instanceId);
    if (!handle) return undefined;
    return {
      taskDescription: handle.instance.taskDescription,
      lastUserPrompt: handle.instance.lastUserPrompt,
    };
  }

  private trackInput(handle: PtyHandle, data: string): void {
    // Strip terminal escape sequences before processing
    // Removes: CSI sequences (\x1b[...X), OSC sequences (\x1b]...ST),
    // bracketed paste markers, and other ANSI escapes
    const cleaned = data.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[^[\]]/g, '');

    for (const ch of cleaned) {
      if (ch === '\r' || ch === '\n') {
        const prompt = handle.inputLineBuffer.trim();
        if (prompt.length > 0) {
          handle.instance.lastUserPrompt = prompt;
          this.emit('context', handle.instance.id, {
            taskDescription: handle.instance.taskDescription,
            lastUserPrompt: handle.instance.lastUserPrompt,
          });
        }
        handle.inputLineBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        handle.inputLineBuffer = handle.inputLineBuffer.slice(0, -1);
      } else if (ch.charCodeAt(0) >= 32) {
        handle.inputLineBuffer += ch;
      }
    }
  }

  resize(instanceId: string, cols: number, rows: number): void {
    const handle = this.handles.get(instanceId);
    if (!handle || handle.instance.status === INSTANCE_STATUS.EXITED) return;
    handle.process.resize(cols, rows);
  }

  getBuffer(instanceId: string): string {
    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error(`Instance ${instanceId} not found`);
    return handle.buffer.join('');
  }

  updateStatus(instanceId: string, status: InstanceStatus): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    if (handle.instance.status === status) return;
    if (handle.instance.status === INSTANCE_STATUS.EXITED) return;

    handle.instance.status = status;
    this.emit('status', instanceId, status);
  }

  getLastActivity(instanceId: string): Date | undefined {
    return this.handles.get(instanceId)?.instance.lastActivity;
  }

  private appendBuffer(handle: PtyHandle, data: string): void {
    // Store raw chunks to preserve terminal escape sequences
    handle.buffer.push(data);
    handle.bufferSize += data.length;

    // Trim buffer if over byte limit — drop oldest chunks
    while (handle.bufferSize > this.MAX_BUFFER_BYTES && handle.buffer.length > 1) {
      const removed = handle.buffer.shift()!;
      handle.bufferSize -= removed.length;
    }
  }

  async killAll(): Promise<void> {
    const ids = Array.from(this.handles.keys());
    if (ids.length === 0) return;

    console.log(`[process-manager] Killing all ${ids.length} instances...`);

    // Kill all with a hard 8s ceiling
    await Promise.race([
      Promise.all(ids.map(id => this.kill(id))),
      new Promise<void>(resolve => setTimeout(() => {
        console.log('[process-manager] killAll hard timeout, force cleaning remaining');
        this.forceDestroyAll();
        resolve();
      }, 8000)),
    ]);
  }

  private forceDestroyAll(): void {
    for (const [id, handle] of this.handles) {
      try {
        process.kill(handle.instance.pid, 'SIGKILL');
      } catch {
        // Already gone
      }
      this.handles.delete(id);
    }
  }
}

export { INSTANCE_STATUS };
export type { Instance, InstanceStatus, SpawnOptions, InstanceContext };
