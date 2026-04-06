import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// --- Types ---

export interface RtkStatus {
  installed: boolean;
  version: string | null;
  hooksInstalled: boolean;
  hookDetails: string;
}

export interface RtkStats {
  totalTokensSaved: number;
  totalTokensOriginal: number;
  savingsPercent: number;
  commandCount: number;
  raw: unknown;
}

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 10_000 };

export class RtkService {
  private rtkBinary: string | null = null;
  private statusCache: RtkStatus | null = null;
  private statusCacheTime = 0;
  private static STATUS_CACHE_TTL = 30_000;

  resolveRtkBinary(): string | null {
    if (this.rtkBinary !== null) return this.rtkBinary;

    const candidates = [
      path.join(os.homedir(), '.local', 'bin', 'rtk'),
      '/usr/local/bin/rtk',
      '/opt/homebrew/bin/rtk',
    ];

    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        this.rtkBinary = candidate;
        return candidate;
      } catch { /* not found */ }
    }

    const pathDirs = (process.env.PATH ?? '').split(':');
    for (const dir of pathDirs) {
      const candidate = path.join(dir, 'rtk');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        this.rtkBinary = candidate;
        return candidate;
      } catch { /* not found */ }
    }

    return null;
  }

  private exec(args: string): string | null {
    const binary = this.resolveRtkBinary();
    if (!binary) return null;
    try {
      return execSync(`${binary} ${args}`, {
        ...EXEC_OPTS,
        env: { ...process.env, PATH: `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` },
      }).trim();
    } catch {
      return null;
    }
  }

  isInstalled(): boolean {
    return this.resolveRtkBinary() !== null;
  }

  getVersion(): string | null {
    return this.exec('--version') ?? null;
  }

  getHookStatus(): { installed: boolean; details: string } {
    const output = this.exec('init --show');
    if (!output) return { installed: false, details: 'RTK not installed or init --show failed' };
    const hasHook = output.toLowerCase().includes('hook') && !output.toLowerCase().includes('not installed');
    return { installed: hasHook, details: output };
  }

  installHooks(): { success: boolean; output: string } {
    const binary = this.resolveRtkBinary();
    if (!binary) return { success: false, output: 'RTK binary not found' };
    try {
      const output = execSync(`${binary} init -g --auto-patch`, {
        ...EXEC_OPTS,
        env: { ...process.env, PATH: `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` },
      });
      this.statusCache = null;
      return { success: true, output: output.trim() };
    } catch (err) {
      const message = err instanceof Error ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? err.message : 'Unknown error';
      return { success: false, output: String(message) };
    }
  }

  uninstallHooks(): { success: boolean; output: string } {
    const binary = this.resolveRtkBinary();
    if (!binary) return { success: false, output: 'RTK binary not found' };
    try {
      const output = execSync(`${binary} init -g --uninstall`, {
        ...EXEC_OPTS,
        env: { ...process.env, PATH: `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` },
      });
      this.statusCache = null;
      return { success: true, output: output.trim() };
    } catch (err) {
      const message = err instanceof Error ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? err.message : 'Unknown error';
      return { success: false, output: String(message) };
    }
  }

  getStats(): RtkStats | null {
    const output = this.exec('gain --all --format json');
    if (!output) return null;
    try {
      const data = JSON.parse(output) as Record<string, unknown>;
      const totalTokensSaved = (data.tokens_saved as number) ?? (data.total_tokens_saved as number) ?? 0;
      const totalTokensOriginal = (data.tokens_original as number) ?? (data.total_tokens_original as number) ?? 0;
      const savingsPercent = totalTokensOriginal > 0
        ? Math.round((totalTokensSaved / totalTokensOriginal) * 100)
        : (data.savings_percent as number) ?? 0;
      const commandCount = (data.command_count as number) ?? (data.total_commands as number) ?? 0;
      return { totalTokensSaved, totalTokensOriginal, savingsPercent, commandCount, raw: data };
    } catch {
      return null;
    }
  }

  getGraph(): string | null {
    return this.exec('gain --graph');
  }

  getHistory(): string | null {
    return this.exec('gain --history');
  }

  discover(): string | null {
    return this.exec('discover');
  }

  getStatus(): RtkStatus {
    const now = Date.now();
    if (this.statusCache && (now - this.statusCacheTime) < RtkService.STATUS_CACHE_TTL) {
      return this.statusCache;
    }

    const installed = this.isInstalled();
    const version = installed ? this.getVersion() : null;
    const hookStatus = installed ? this.getHookStatus() : { installed: false, details: 'RTK not installed' };

    const status: RtkStatus = {
      installed,
      version,
      hooksInstalled: hookStatus.installed,
      hookDetails: hookStatus.details,
    };

    this.statusCache = status;
    this.statusCacheTime = now;
    return status;
  }
}
