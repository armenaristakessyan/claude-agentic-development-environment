export interface Project {
  name: string;
  path: string;
  gitBranch: string | null;
  hasClaudeMd: boolean;
  lastModified: string;
  isWorktree: boolean;
  parentProject?: string;
}

export const INSTANCE_STATUS = {
  PROCESSING: 'processing',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  EXITED: 'exited',
} as const;

export type InstanceStatus = typeof INSTANCE_STATUS[keyof typeof INSTANCE_STATUS];

export interface Instance {
  id: string;
  projectPath: string;
  projectName: string;
  status: InstanceStatus;
  createdAt: string;
  lastActivity: string;
  taskDescription: string | null;
  worktreePath: string | null;
  parentProjectPath: string | null;
  branchName: string | null;
  sessionId: string | null;
  model: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  effort: string | null;
  permissionMode: string | null;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  stdout?: string;
  stderr?: string;
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

export interface SessionInfo {
  sessionId: string | null;
  model: string | null;
  tools?: string[];
  mcpServers?: { name: string; status: string }[];
  permissionMode?: string;
  cliVersion?: string;
  slashCommands?: string[];
}

export interface ContextAttachment {
  type: 'file' | 'branch' | 'commit' | 'changes';
  label: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp: string;
  contextAttachments?: ContextAttachment[];
}

export interface AttentionQueueItem {
  instanceId: string;
  projectName: string;
  enteredAt: number;
}

export interface AgentTask {
  taskId: string;
  toolUseId: string;
  description: string;
  status: 'running' | 'completed';
  lastToolName?: string;
  startedAt: number;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}

// --- Marketplace ---

export interface PluginMetadata {
  name: string;
  version?: string;
  description: string;
  author?: { name: string; email?: string };
  keywords?: string[];
  marketplace: string;
  segment?: string;
  isInstalled: boolean;
  installCount?: number;
  skillCount: number;
  skills: SkillSummary[];
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  allowedTools?: string[];
  scope?: ScopeContract;
}

export interface ScopeContract {
  allowedTools?: string[];
  maxSteps?: number;
  allowedCommands?: string[];
  forbiddenPatterns?: string[];
}
