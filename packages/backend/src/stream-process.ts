import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { AppConfig } from './config.js';
import type { TaskStore } from './task-store.js';

function resolveClaudeBinary(): string {
  const fs = require('fs') as typeof import('fs');
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not found */ }
  }
  const pathDirs = (process.env.PATH ?? '').split(':');
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not found */ }
  }
  return 'claude';
}

// Event types from Claude Code stream-json
interface StreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'rate_limit_event' | 'stream_event';
  [key: string]: unknown;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp: string;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  stdout?: string;
  stderr?: string;
  structuredPatch?: unknown;
}

const INSTANCE_STATUS = {
  IDLE: 'idle',
  PROCESSING: 'processing',
  WAITING_INPUT: 'waiting_input',
  EXITED: 'exited',
} as const;

type InstanceStatus = typeof INSTANCE_STATUS[keyof typeof INSTANCE_STATUS];

interface StreamInstance {
  id: string;
  projectPath: string;
  projectName: string;
  status: InstanceStatus;
  createdAt: Date;
  lastActivity: Date;
  taskDescription: string | null;
  worktreePath: string | null;
  parentProjectPath: string | null;
  branchName: string | null;
  sessionId: string | null;
  messages: ChatMessage[];
  model: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  effort: string | null;
  permissionMode: string | null;
}

interface SpawnOptions {
  projectPath: string;
  taskDescription?: string;
  worktreePath?: string;
  parentProjectPath?: string;
  branchName?: string;
  continueSession?: boolean;
  sessionId?: string;
  // Restored from stored task on resume
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
}


interface ProcessHandle {
  instance: StreamInstance;
  currentProcess: ChildProcess | null;
  lineBuffer: string;
  // Per-instance approved tools (for "ask" permission mode)
  approvedTools: Set<string>;
  // Track the last denied tool_use so we can show it to the user
  lastDeniedTool: { toolName: string; toolInput: unknown; toolUseId: string; filePath?: string } | null;
}

export class StreamProcessManager extends EventEmitter {
  private handles = new Map<string, ProcessHandle>();
  private readonly claudeBinary: string;
  private cachedSlashCommands: string[] | null = null;

  constructor(private config: AppConfig, private taskStore?: TaskStore) {
    super();
    this.claudeBinary = resolveClaudeBinary();
    console.log(`[stream-process] Using claude binary: ${this.claudeBinary}`);
  }

  getSlashCommands(): string[] {
    return this.cachedSlashCommands ?? [];
  }

  /** Pre-fetch slash commands by running a quick no-op claude invocation */
  async prefetchSlashCommands(): Promise<void> {
    if (this.cachedSlashCommands) return;
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      const output = execSync(
        `${this.claudeBinary} --print --output-format stream-json --verbose --max-turns 0 ""`,
        { encoding: 'utf-8', timeout: 30_000, cwd: os.homedir() }
      );
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.slash_commands) {
            this.cachedSlashCommands = event.slash_commands as string[];
            console.log(`[stream-process] Pre-fetched ${this.cachedSlashCommands.length} slash commands`);
            return;
          }
        } catch { /* skip non-json */ }
      }
    } catch (err) {
      console.log('[stream-process] Failed to pre-fetch slash commands:', err);
    }
  }

  async createInstance(options: SpawnOptions): Promise<StreamInstance> {
    if (this.handles.size >= this.config.maxInstances) {
      throw new Error(`Maximum instances reached (${this.config.maxInstances})`);
    }

    const id = randomUUID();
    const projectName = path.basename(options.projectPath);

    const instance: StreamInstance = {
      id,
      projectPath: options.projectPath,
      projectName,
      status: INSTANCE_STATUS.WAITING_INPUT,
      createdAt: new Date(),
      lastActivity: new Date(),
      taskDescription: options.taskDescription ?? null,
      worktreePath: options.worktreePath ?? null,
      parentProjectPath: options.parentProjectPath ?? null,
      branchName: options.branchName ?? null,
      sessionId: options.sessionId ?? null,
      messages: [],
      model: options.model ?? null,
      totalCostUsd: options.totalCostUsd ?? 0,
      totalInputTokens: options.totalInputTokens ?? 0,
      totalOutputTokens: options.totalOutputTokens ?? 0,
      effort: options.effort ?? null,
      permissionMode: options.permissionMode ?? null,
    };

    const handle: ProcessHandle = {
      instance,
      currentProcess: null,
      lineBuffer: '',
      approvedTools: new Set<string>(),
      lastDeniedTool: null,
    };

    this.handles.set(id, handle);
    this.emit('status', id, INSTANCE_STATUS.WAITING_INPUT);

    // On resume, load saved messages from disk
    if (options.continueSession && options.sessionId && this.taskStore) {
      const savedMessages = this.taskStore.loadMessagesBySessionId(options.sessionId) as ChatMessage[];
      if (savedMessages.length > 0) {
        instance.messages = savedMessages;
        console.log(`[stream-process] Loaded ${savedMessages.length} messages from history`);
      }
    }

    console.log(`[stream-process] Created instance ${id} for ${options.worktreePath ?? options.projectPath}`);
    return instance;
  }

  async sendMessage(instanceId: string, prompt: string, options?: {
    model?: string;
    permissionMode?: string;
    effort?: string;
    context?: { type: string; label: string; value: string }[];
    hidden?: boolean;
  }): Promise<void> {
    if (!prompt || !prompt.trim()) throw new Error('Prompt cannot be empty');

    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error(`Instance ${instanceId} not found`);
    if (handle.currentProcess) throw new Error('Instance is already processing');

    const instance = handle.instance;
    const cwd = instance.worktreePath ?? instance.projectPath;

    // Sync settings to instance for getAll()
    if (options?.effort) instance.effort = options.effort;
    if (options?.permissionMode) instance.permissionMode = options.permissionMode;

    // Build the display message (clean, no context content)
    // Hidden messages (e.g. permission re-sends) are not shown in the chat
    if (!options?.hidden) {
      const userMessage: ChatMessage & { contextAttachments?: { type: string; label: string }[] } = {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: new Date().toISOString(),
      };
      if (options?.context && options.context.length > 0) {
        userMessage.contextAttachments = options.context.map(c => ({ type: c.type, label: c.label }));
      }
      instance.messages.push(userMessage);
      this.emit('message', instanceId, userMessage);
    }

    // Build the full CLI prompt with context prepended (sent to Claude, not displayed)
    let cliPrompt = prompt;
    if (options?.context && options.context.length > 0) {
      const contextParts = options.context.map(c => {
        switch (c.type) {
          case 'file': return `[File: ${c.label}]\n${c.value}`;
          case 'branch': return `[Git Branch: ${c.label}]`;
          case 'commit': return `[Git Commit: ${c.label}]\n${c.value}`;
          case 'changes': return `[Local Changes]\n${c.value}`;
          default: return c.value;
        }
      });
      cliPrompt = `Context:\n${contextParts.join('\n\n')}\n\n---\n\n${prompt}`;
    }

    // Update status
    instance.status = INSTANCE_STATUS.PROCESSING;
    instance.lastActivity = new Date();
    this.emit('status', instanceId, INSTANCE_STATUS.PROCESSING);

    // All modes use --print (one-shot, non-interactive).
    // Permission control is handled via --allowedTools and --dangerously-skip-permissions.
    // The stream-json output shows exactly what Claude did (tool_use + tool_result events).
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];

    // Model override
    if (options?.model) {
      args.push('--model', options.model);
    }

    // Effort level
    if (options?.effort) {
      args.push('--effort', options.effort);
    }

    // Permission mode mapping — dashboard modes → CLI permission flags
    const mode = options?.permissionMode ?? 'ask';
    switch (mode) {
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'ask':
        args.push('--permission-mode', 'default');
        break;
      case 'auto-edit':
        args.push('--permission-mode', 'acceptEdits');
        break;
      case 'full-access':
        args.push('--permission-mode', 'bypassPermissions');
        break;
      default:
        args.push('--permission-mode', 'default');
    }

    // Pass previously approved tools so Claude can use them without denial
    const approved = this.getApprovedTools(instanceId);
    if (approved.size > 0) {
      args.push('--allowedTools', [...approved].join(','));
    }

    if (instance.sessionId) {
      args.push('--resume', instance.sessionId);
    }

    // Add the prompt (with context baked in for Claude, but not displayed in chat)
    args.push(cliPrompt);

    // Build env
    const env = { ...process.env } as Record<string, string>;
    const extraPaths = [
      path.join(os.homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];
    const currentPath = env.PATH ?? '';
    const pathParts = currentPath.split(':');
    for (const p of extraPaths) {
      if (!pathParts.includes(p)) pathParts.unshift(p);
    }
    env.PATH = pathParts.join(':');
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
        delete env[key];
      }
    }

    console.log(`[stream-process] Running: ${this.claudeBinary} ${args.join(' ').slice(0, 200)}... in ${cwd}`);
    console.log(`[stream-process] Prompt length: ${cliPrompt.length}, first 80 chars: ${cliPrompt.slice(0, 80)}`);

    const proc = spawn(this.claudeBinary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — prompt is passed as CLI argument, not via stdin
    proc.stdin?.end();

    handle.currentProcess = proc;
    handle.lineBuffer = '';
    handle.lastDeniedTool = null;

    // Accumulate assistant content blocks for the current turn
    let assistantBlocks: ContentBlock[] = [];

    proc.stdout?.on('data', (chunk: Buffer) => {
      handle.lineBuffer += chunk.toString();
      const lines = handle.lineBuffer.split('\n');
      handle.lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          this.handleEvent(instanceId, event, assistantBlocks);
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        console.log(`[stream-process] stderr ${instanceId}: ${text.trim()}`);
      }
    });

    proc.on('close', (code) => {
      handle.currentProcess = null;

      // Flush any remaining assistant blocks as a message
      if (assistantBlocks.length > 0) {
        const msg: ChatMessage = {
          role: 'assistant',
          content: assistantBlocks,
          timestamp: new Date().toISOString(),
        };
        instance.messages.push(msg);
        this.emit('message', instanceId, msg);
        assistantBlocks = [];
      }

      if (code !== 0 && code !== null) {
        console.log(`[stream-process] Process exited with code ${code}`);
      }

      // Persist messages to disk
      if (this.taskStore && instance.messages.length > 0) {
        this.taskStore.saveMessages(instanceId, instance.messages).catch(err => {
          console.log(`[stream-process] Failed to persist messages: ${err}`);
        });
      }

      instance.status = INSTANCE_STATUS.WAITING_INPUT;
      instance.lastActivity = new Date();
      this.emit('status', instanceId, INSTANCE_STATUS.WAITING_INPUT);
    });
  }

  private handleEvent(instanceId: string, event: StreamEvent, assistantBlocks: ContentBlock[]): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    const instance = handle.instance;

    switch (event.type) {
      case 'system': {
        const sys = event as {
          session_id?: string;
          model?: string;
          subtype?: string;
          tools?: string[];
          mcp_servers?: { name: string; status: string }[];
          permissionMode?: string;
          claude_code_version?: string;
          slash_commands?: string[];
          // Agent task events
          task_id?: string;
          tool_use_id?: string;
          description?: string;
          task_type?: string;
          status?: string;
          last_tool_name?: string;
          usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
        };

        // Agent task lifecycle events
        if (sys.subtype === 'task_started') {
          this.emit('agent_event', instanceId, {
            event: 'started',
            taskId: sys.task_id,
            toolUseId: sys.tool_use_id,
            description: sys.description,
            taskType: sys.task_type,
          });
          break;
        }
        if (sys.subtype === 'task_progress') {
          this.emit('agent_event', instanceId, {
            event: 'progress',
            taskId: sys.task_id,
            toolUseId: sys.tool_use_id,
            description: sys.description,
            lastToolName: sys.last_tool_name,
            usage: sys.usage,
          });
          break;
        }
        if (sys.subtype === 'task_notification') {
          this.emit('agent_event', instanceId, {
            event: 'completed',
            taskId: sys.task_id,
            toolUseId: sys.tool_use_id,
            status: sys.status,
            description: sys.description,
            usage: sys.usage,
          });
          break;
        }

        // Session init
        if (sys.session_id) instance.sessionId = sys.session_id;
        if (sys.model) instance.model = sys.model;
        if (sys.permissionMode) instance.permissionMode = sys.permissionMode;
        if (sys.slash_commands) {
          this.cachedSlashCommands = sys.slash_commands;
        }
        this.emit('session', instanceId, {
          sessionId: sys.session_id,
          model: sys.model,
          tools: sys.tools,
          mcpServers: sys.mcp_servers,
          permissionMode: sys.permissionMode,
          cliVersion: sys.claude_code_version,
          slashCommands: sys.slash_commands,
        });
        break;
      }

      case 'assistant': {
        const message = (event as { message?: { content?: ContentBlock[] } }).message;
        if (message?.content) {
          for (const block of message.content) {
            assistantBlocks.push(block);
            this.emit('content_block', instanceId, block);

            // Detect AskUserQuestion — Claude wants to ask the user something
            if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
              const inp = block.input as { questions?: Array<{
                question: string;
                header?: string;
                options?: Array<{ label: string; description?: string }>;
                allowMultiple?: boolean;
              }> } | null;
              if (inp?.questions) {
                this.emit('user_question', instanceId, {
                  toolUseId: block.tool_use_id,
                  questions: inp.questions,
                });
              }
            }
          }
        }
        break;
      }

      case 'user': {
        const message = (event as { message?: { content?: ContentBlock[] } }).message;
        const toolUseResult = (event as { tool_use_result?: unknown }).tool_use_result;

        // Detect permission denials from the CLI
        // The tool_use_result can be a string or an object — check both forms
        const resultStr = typeof toolUseResult === 'string'
          ? toolUseResult
          : (toolUseResult as { stdout?: string })?.stdout ?? '';
        const errorContent = message?.content?.find(b => b.type === 'tool_result' && b.is_error)?.content;
        const denialText = (typeof errorContent === 'string' ? errorContent : '') || resultStr;

        if (denialText.includes('requested permissions')) {
          const lastToolUse = assistantBlocks.filter(b => b.type === 'tool_use').pop();
          if (lastToolUse) {
            const inp = lastToolUse.input as Record<string, unknown> | null;
            handle.lastDeniedTool = {
              toolName: lastToolUse.name ?? 'Unknown',
              toolInput: lastToolUse.input,
              toolUseId: lastToolUse.tool_use_id ?? '',
              filePath: (inp?.file_path as string) ?? (inp?.command as string) ?? undefined,
            };
            this.emit('permission_request', instanceId, handle.lastDeniedTool);
          }
        }

        // Forward tool results to the client, enriched with structured data
        if (message?.content) {
          for (const block of message.content) {
            if (block.type === 'tool_result') {
              // Enrich with structured tool_use_result data if available
              const enriched = { ...block };
              if (toolUseResult && typeof toolUseResult === 'object') {
                const tur = toolUseResult as {
                  stdout?: string; stderr?: string; interrupted?: boolean;
                  isImage?: boolean; filePath?: string;
                  structuredPatch?: unknown;
                };
                if (tur.stdout !== undefined) enriched.stdout = tur.stdout;
                if (tur.stderr !== undefined) enriched.stderr = tur.stderr;
                if (tur.structuredPatch !== undefined) enriched.structuredPatch = tur.structuredPatch;
              }
              this.emit('content_block', instanceId, enriched);
            }
          }
        }
        break;
      }

      case 'result': {
        const result = event as {
          total_cost_usd?: number;
          duration_ms?: number;
          session_id?: string;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          permission_denials?: Array<{
            tool_name: string; tool_use_id: string; tool_input: unknown;
          }>;
        };
        if (result.total_cost_usd) {
          instance.totalCostUsd += result.total_cost_usd;
        }
        const inputTokens = result.usage?.input_tokens ?? 0;
        const outputTokens = result.usage?.output_tokens ?? 0;
        instance.totalInputTokens += inputTokens;
        instance.totalOutputTokens += outputTokens;
        if (result.session_id) {
          instance.sessionId = result.session_id;
        }
        this.emit('result', instanceId, {
          costUsd: result.total_cost_usd,
          durationMs: result.duration_ms,
          stopReason: result.stop_reason,
          inputTokens,
          outputTokens,
          totalInputTokens: instance.totalInputTokens,
          totalOutputTokens: instance.totalOutputTokens,
        });

        // Emit permission denials from result so frontend can show approve UI
        if (result.permission_denials && result.permission_denials.length > 0) {
          for (const denial of result.permission_denials) {
            const inp = denial.tool_input as Record<string, unknown> | null;
            this.emit('permission_request', instanceId, {
              toolName: denial.tool_name,
              toolInput: denial.tool_input,
              toolUseId: denial.tool_use_id,
              filePath: (inp?.file_path as string) ?? (inp?.command as string) ?? undefined,
            });
          }
        }
        break;
      }

      case 'stream_event': {
        const inner = (event as {
          event?: {
            type: string;
            index?: number;
            delta?: { type: string; text?: string };
            content_block?: { type: string; id?: string; name?: string };
          };
        }).event;
        if (!inner) break;

        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
          this.emit('stream_delta', instanceId, { text: inner.delta.text });
        } else if (inner.type === 'content_block_start') {
          this.emit('stream_delta', instanceId, {
            type: 'start',
            blockType: inner.content_block?.type,
            blockName: inner.content_block?.name,
          });
        } else if (inner.type === 'content_block_stop') {
          this.emit('stream_delta', instanceId, { type: 'stop' });
        }
        break;
      }

      case 'rate_limit_event': {
        const info = (event as {
          rate_limit_info?: {
            status: string;
            resetsAt?: number;
            rateLimitType?: string;
          };
        }).rate_limit_info;
        if (info) {
          this.emit('rate_limit', instanceId, {
            status: info.status,
            resetsAt: info.resetsAt,
            rateLimitType: info.rateLimitType,
          });
        }
        break;
      }
    }
  }

  getAll(): StreamInstance[] {
    return Array.from(this.handles.values()).map(h => ({
      ...h.instance,
      messages: [], // Don't send full message history in list
    }));
  }

  get(instanceId: string): StreamInstance | undefined {
    const handle = this.handles.get(instanceId);
    return handle ? { ...handle.instance } : undefined;
  }

  /**
   * Approve a tool for this instance. The tool will be included in --allowedTools
   * on the next message, so Claude can use it without getting denied.
   */
  approveTool(instanceId: string, toolName: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    handle.approvedTools.add(toolName);
    console.log(`[stream-process] Approved tool '${toolName}' for instance ${instanceId}. Approved: [${[...handle.approvedTools].join(', ')}]`);
  }

  /**
   * Get the set of approved tools for building --allowedTools on the next message.
   */
  getApprovedTools(instanceId: string): Set<string> {
    const handle = this.handles.get(instanceId);
    return handle?.approvedTools ?? new Set();
  }

  clearSession(instanceId: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    handle.instance.sessionId = null;
    handle.instance.messages = [];
    handle.approvedTools.clear();
    handle.instance.status = INSTANCE_STATUS.WAITING_INPUT;
    this.emit('status', instanceId, INSTANCE_STATUS.WAITING_INPUT);
    console.log(`[stream-process] Session cleared for instance ${instanceId}`);
  }

  getMessages(instanceId: string): ChatMessage[] {
    const handle = this.handles.get(instanceId);
    return handle ? [...handle.instance.messages] : [];
  }

  async kill(instanceId: string): Promise<void> {
    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error(`Instance ${instanceId} not found`);

    if (handle.currentProcess) {
      handle.currentProcess.kill('SIGTERM');
      // Force kill after 3s
      setTimeout(() => {
        try { handle.currentProcess?.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3000);
    }

    handle.instance.status = INSTANCE_STATUS.EXITED;
    this.emit('status', instanceId, INSTANCE_STATUS.EXITED);
    this.emit('exited', instanceId, 0);
    this.handles.delete(instanceId);
  }

  async killAll(): Promise<void> {
    const ids = Array.from(this.handles.keys());
    await Promise.all(ids.map(id => this.kill(id)));
  }
}

export { INSTANCE_STATUS };
export type { StreamInstance, InstanceStatus, SpawnOptions, ChatMessage, ContentBlock };
