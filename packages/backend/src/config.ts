import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.claude-dashboard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface AppConfig {
  scanPaths: string[];
  projectMarkers: string[];
  scanDepth: number;
  port: number;
  maxInstances: number;
  statusPatterns: {
    waitingInput: string[];
  };
  theme: 'dark' | 'light';
  zoom: 100 | 110 | 125 | 150;
}

const DEFAULT_CONFIG: AppConfig = {
  scanPaths: [
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), 'work'),
    path.join(os.homedir(), 'Workspace'),
  ],
  projectMarkers: ['.git', 'CLAUDE.md', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'],
  scanDepth: 3,
  port: 3200,
  maxInstances: 10,
  statusPatterns: {
    waitingInput: [
      '\\$\\s*$',
      '>\\s*$',
      '\\?\\s*$',
      'waiting for input',
      '╭─',
    ],
  },
  theme: 'dark',
  zoom: 100,
};

export class ConfigService {
  private config: AppConfig | null = null;

  async load(): Promise<AppConfig> {
    if (this.config) return this.config;

    try {
      const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      this.config = { ...DEFAULT_CONFIG };
      await this.save(this.config);
    }

    return this.config!;
  }

  async save(updates: Partial<AppConfig>): Promise<AppConfig> {
    const current = this.config ?? { ...DEFAULT_CONFIG };
    this.config = { ...current, ...updates } as AppConfig;

    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');

    return this.config;
  }

  async get(): Promise<AppConfig> {
    return this.load();
  }
}

export type { AppConfig };
