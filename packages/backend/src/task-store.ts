import fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const STORE_DIR = path.join(os.homedir(), '.claude-dashboard');
const STORE_FILE = path.join(STORE_DIR, 'tasks.json');


interface StoredTask {
  id: string;
  projectPath: string;
  projectName: string;
  taskDescription: string | null;
  worktreePath: string | null;
  parentProjectPath: string | null;
  branchName: string | null;
  sessionId: string | null;
  status: 'active' | 'exited';
  createdAt: string;
  exitedAt: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  approvedTools: string[];
}

export class TaskStore {
  private tasks: StoredTask[] = [];

  constructor() {
    this.loadSync();
  }

  private loadSync(): void {
    try {
      if (existsSync(STORE_FILE)) {
        const raw = readFileSync(STORE_FILE, 'utf-8');
        this.tasks = JSON.parse(raw);
        // Migrate old tasks missing fields
        for (const task of this.tasks) {
          task.totalCostUsd ??= 0;
          task.totalInputTokens ??= 0;
          task.totalOutputTokens ??= 0;
          task.model ??= null;
          task.effort ??= null;
          task.permissionMode ??= null;
          task.approvedTools ??= [];
        }
        this.saveSync();
      }
    } catch (err) {
      console.log('[task-store] Failed to load tasks:', err);
      this.tasks = [];
    }
  }

  private saveSync(): void {
    try {
      mkdirSync(STORE_DIR, { recursive: true });
      writeFileSync(STORE_FILE, JSON.stringify(this.tasks, null, 2), 'utf-8');
    } catch (err) {
      console.log('[task-store] Failed to save tasks:', err);
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(STORE_DIR, { recursive: true });
      await fs.writeFile(STORE_FILE, JSON.stringify(this.tasks, null, 2), 'utf-8');
    } catch (err) {
      console.log('[task-store] Failed to save tasks:', err);
    }
  }

  /**
   * Rewrite any task.model that isn't a valid SDK alias to the equivalent
   * alias. Legacy installs persisted the SDK's resolved model names (e.g.
   * claude-sonnet-4-6[1m]) which don't match the alias ids (sonnet[1m])
   * that the dropdown operates on. Called once at boot after the model
   * list is known.
   */
  async migrateInvalidModels(validAliases: string[]): Promise<number> {
    if (validAliases.length === 0) return 0;
    const valid = new Set(validAliases);

    // Deterministic mapping from known resolved names to the equivalent
    // alias. Kept explicit — no string heuristics.
    const RESOLVED_TO_ALIAS: Record<string, string> = {
      'claude-opus-4-7[1m]': 'default',
      'claude-opus-4-7': 'default',
      'claude-opus-4-6[1m]': 'default',
      'claude-opus-4-6': 'default',
      'claude-sonnet-4-6[1m]': 'sonnet[1m]',
      'claude-sonnet-4-6': 'sonnet',
      'claude-sonnet-4-5[1m]': 'sonnet[1m]',
      'claude-sonnet-4-5': 'sonnet',
      'claude-haiku-4-5': 'haiku',
    };
    const fallback = valid.has('default') ? 'default' : validAliases[0];

    let changed = 0;
    for (const task of this.tasks) {
      if (!task.model || valid.has(task.model)) continue;
      const mapped = RESOLVED_TO_ALIAS[task.model];
      task.model = mapped && valid.has(mapped) ? mapped : fallback;
      changed++;
    }
    if (changed > 0) {
      await this.save();
      console.log(`[task-store] Migrated ${changed} task(s) with invalid model aliases`);
    }
    return changed;
  }

  async updateCost(taskId: string, costUsd: number): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.totalCostUsd = (task.totalCostUsd ?? 0) + costUsd;
      await this.save();
    }
  }

  async updateStats(taskId: string, stats: {
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (stats.costUsd) task.totalCostUsd = (task.totalCostUsd ?? 0) + stats.costUsd;
    if (stats.inputTokens) task.totalInputTokens = (task.totalInputTokens ?? 0) + stats.inputTokens;
    if (stats.outputTokens) task.totalOutputTokens = (task.totalOutputTokens ?? 0) + stats.outputTokens;
    if (stats.model) task.model = stats.model;
    await this.save();
  }

  async updateSettings(taskId: string, settings: {
    effort?: string;
    permissionMode?: string;
    model?: string;
  }): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (settings.effort) task.effort = settings.effort;
    if (settings.permissionMode) task.permissionMode = settings.permissionMode;
    if (settings.model) task.model = settings.model;
    await this.save();
  }

  async setApprovedTools(taskId: string, approvedTools: string[]): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.approvedTools = [...approvedTools];
    await this.save();
  }

  async addTask(task: Omit<StoredTask, 'status' | 'exitedAt'>): Promise<void> {
    // Remove any existing task with the same ID
    this.tasks = this.tasks.filter(t => t.id !== task.id);
    this.tasks.unshift({
      ...task,
      status: 'active',
      exitedAt: null,
    });
    // Keep max 50 tasks in history
    if (this.tasks.length > 50) {
      this.tasks = this.tasks.slice(0, 50);
    }
    await this.save();
  }

  async updateSessionId(taskId: string, sessionId: string): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.sessionId = sessionId;
      await this.save();
    }
  }

  async markExited(taskId: string): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'exited';
      task.exitedAt = new Date().toISOString();
      await this.save();
    }
  }

  async removeTask(taskId: string): Promise<void> {
    this.tasks = this.tasks.filter(t => t.id !== taskId);
    await this.save();
  }

  getAll(): StoredTask[] {
    return [...this.tasks];
  }

  getActive(): StoredTask[] {
    return this.tasks.filter(t => t.status === 'active');
  }

  getHistory(): StoredTask[] {
    return this.tasks.filter(t => t.status === 'exited');
  }

  // Find tasks that have worktrees still on disk but no running instance
  getOrphaned(activeInstanceIds: Set<string>): StoredTask[] {
    return this.tasks.filter(t =>
      t.worktreePath &&
      t.status === 'exited' &&
      !activeInstanceIds.has(t.id) &&
      existsSync(t.worktreePath),
    );
  }
}

export type { StoredTask };
