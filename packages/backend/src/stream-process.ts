import path from 'path';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  CanUseTool,
  PermissionResult,
  SessionMessage,
  ModelInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AppConfig } from './config.js';
import type { TaskStore } from './task-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp: string;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
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
  tools: string[] | null;
  mcpServers: { name: string; status: string }[] | null;
}

interface SpawnOptions {
  projectPath: string;
  taskDescription?: string;
  worktreePath?: string;
  parentProjectPath?: string;
  branchName?: string;
  continueSession?: boolean;
  sessionId?: string;
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Preserve original creation timestamp when resuming a task */
  createdAt?: Date;
  /** Preserve persisted last-activity timestamp on resume (without it,
   *  every auto-resume on backend restart would bump the task to "now"). */
  lastActivity?: Date;
  /** Previously-approved tools for this task (per-task allowlist) */
  approvedTools?: string[];
  /** Reuse a specific id (used when resuming a persisted task at boot so
   *  the instance id stays stable across backend restarts). */
  id?: string;
}

// ---------------------------------------------------------------------------
// Pending permission / user-question request — resolved from outside
// ---------------------------------------------------------------------------

interface PendingPermission {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  filePath?: string;
  title?: string;
  description?: string;
  resolve: (result: PermissionResult) => void;
}

interface PendingUserQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    allowMultiple?: boolean;
  }>;
  resolve: (result: PermissionResult) => void;
}

// ---------------------------------------------------------------------------
// Per-instance handle
// ---------------------------------------------------------------------------

interface ProcessHandle {
  instance: StreamInstance;
  conversation: Query | null;
  abortController: AbortController | null;
  /** Async generator that feeds user messages into the conversation */
  inputController: InputController | null;
  /** Pending permission callbacks, keyed by toolUseId (supports concurrent requests) */
  pendingPermissions: Map<string, PendingPermission>;
  /** Pending AskUserQuestion callbacks, keyed by toolUseId (supports concurrent requests) */
  pendingUserQuestions: Map<string, PendingUserQuestion>;
  /** Per-instance approved tools (for "ask" permission mode) */
  approvedTools: Set<string>;
  /** In-progress content blocks for the current turn (flushed on result) */
  streamingBlocks: ContentBlock[];
}

// ---------------------------------------------------------------------------
// InputController — a push-based AsyncIterable<SDKUserMessage>
// ---------------------------------------------------------------------------

class InputController {
  private queue: SDKUserMessage[] = [];
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  push(msg: SDKUserMessage): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        return new Promise(resolve => { this.waiting = resolve; });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// StreamProcessManager — now backed by the Agent SDK
// ---------------------------------------------------------------------------

export class StreamProcessManager extends EventEmitter {
  private handles = new Map<string, ProcessHandle>();
  private cachedSlashCommands: string[] | null = null;
  private cachedSupportedModels: ModelInfo[] | null = null;
  private pluginPathsProvider: (() => string[]) | null = null;
  private cwdPrefetchCache = new Map<string, { slashCommands: string[]; models: ModelInfo[]; mcpServers: { name: string; status: string }[]; tools: string[]; cliVersion: string | null }>();
  private cwdPrefetchInFlight = new Map<string, Promise<{ slashCommands: string[]; models: ModelInfo[]; mcpServers: { name: string; status: string }[]; tools: string[]; cliVersion: string | null }>>();

  constructor(private config: AppConfig, private taskStore?: TaskStore) {
    super();
  }

  /** Set a callback that returns filesystem paths of installed plugins */
  setPluginPathsProvider(provider: () => string[]): void {
    this.pluginPathsProvider = provider;
  }

  private getPluginConfigs(): Array<{ type: 'local'; path: string }> {
    if (!this.pluginPathsProvider) return [];
    return this.pluginPathsProvider().map(p => ({ type: 'local' as const, path: p }));
  }

  getSlashCommands(): string[] {
    return this.cachedSlashCommands ?? [];
  }

  getCachedSupportedModels(): ModelInfo[] {
    return this.cachedSupportedModels ?? [];
  }

  /** Pre-fetch slash commands and supported models by spawning a short-lived SDK query */
  async prefetchSlashCommands(force = false): Promise<void> {
    if (this.cachedSlashCommands && this.cachedSupportedModels && !force) return;
    try {
      const plugins = this.getPluginConfigs();
      const conversation = query({
        prompt: 'hi',
        options: {
          maxTurns: 0,
          persistSession: false,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['project', 'local'],
          plugins: plugins.length > 0 ? plugins : undefined,
        },
      });
      for await (const msg of conversation) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.cachedSlashCommands = msg.slash_commands ?? [];
          try {
            this.cachedSupportedModels = await conversation.supportedModels();
            console.log(`[stream-process] Pre-fetched ${this.cachedSlashCommands.length} slash commands, ${this.cachedSupportedModels.length} models`);
          } catch (err) {
            console.log('[stream-process] Failed to fetch supported models during prefetch:', err);
          }
          break;
        }
      }
      conversation.close();
    } catch (err) {
      console.log('[stream-process] Failed to pre-fetch slash commands:', err);
    }
  }

  /**
   * Prefetch slash commands + supported models for a specific cwd so the UI
   * can display the correct project-local plugins. Cached per-cwd; concurrent
   * callers for the same cwd share the same in-flight query.
   */
  async prefetchForCwd(cwd: string): Promise<{ slashCommands: string[]; models: ModelInfo[]; mcpServers: { name: string; status: string }[]; tools: string[]; cliVersion: string | null }> {
    const cached = this.cwdPrefetchCache.get(cwd);
    if (cached) return cached;
    const inFlight = this.cwdPrefetchInFlight.get(cwd);
    if (inFlight) return inFlight;

    const run = (async () => {
      let slashCommands: string[] = [];
      let models: ModelInfo[] = [];
      let mcpServers: { name: string; status: string }[] = [];
      let tools: string[] = [];
      let cliVersion: string | null = null;
      try {
        const plugins = this.getPluginConfigs();
        const conversation = query({
          prompt: 'hi',
          options: {
            cwd,
            maxTurns: 0,
            persistSession: false,
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            settingSources: ['project', 'local'],
            plugins: plugins.length > 0 ? plugins : undefined,
          },
        });
        for await (const msg of conversation) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            slashCommands = msg.slash_commands ?? [];
            if (msg.mcp_servers) mcpServers = msg.mcp_servers;
            if (msg.tools) tools = msg.tools;
            if (msg.claude_code_version) cliVersion = msg.claude_code_version;
            try {
              models = await conversation.supportedModels();
            } catch (err) {
              console.log(`[stream-process] prefetchForCwd supportedModels failed for ${cwd}:`, err);
            }
            break;
          }
        }
        conversation.close();
      } catch (err) {
        console.log(`[stream-process] prefetchForCwd failed for ${cwd}:`, err);
      }

      // Fallback: if the cwd-scoped query didn't return models, use the
      // global cache (warming it if needed) so the dropdown always has
      // labels available.
      if (models.length === 0) {
        if (!this.cachedSupportedModels || this.cachedSupportedModels.length === 0) {
          await this.prefetchSlashCommands();
        }
        models = this.cachedSupportedModels ?? [];
      }
      if (slashCommands.length === 0) {
        slashCommands = this.cachedSlashCommands ?? [];
      }

      const result = { slashCommands, models, mcpServers, tools, cliVersion };
      console.log(`[stream-process] prefetchForCwd(${cwd}): ${slashCommands.length} slash commands, ${models.length} models, ${mcpServers.length} mcp servers, ${tools.length} tools, cli=${cliVersion ?? 'unknown'}`);
      if (slashCommands.length > 0 || models.length > 0 || mcpServers.length > 0 || tools.length > 0 || cliVersion) {
        this.cwdPrefetchCache.set(cwd, result);
        if (!this.cachedSlashCommands && slashCommands.length > 0) this.cachedSlashCommands = slashCommands;
        if (!this.cachedSupportedModels && models.length > 0) this.cachedSupportedModels = models;
      }
      this.cwdPrefetchInFlight.delete(cwd);
      return result;
    })();

    this.cwdPrefetchInFlight.set(cwd, run);
    return run;
  }

  /** Invalidate the per-cwd prefetch cache (e.g. when plugins change). */
  invalidatePrefetchCache(): void {
    this.cwdPrefetchCache.clear();
  }

  async createInstance(options: SpawnOptions): Promise<StreamInstance> {
    if (this.handles.size >= this.config.maxInstances) {
      throw new Error(`Maximum instances reached (${this.config.maxInstances})`);
    }

    const id = options.id ?? randomUUID();
    const projectName = path.basename(options.projectPath);

    const instance: StreamInstance = {
      id,
      projectPath: options.projectPath,
      projectName,
      status: INSTANCE_STATUS.WAITING_INPUT,
      createdAt: options.createdAt ?? new Date(),
      lastActivity: options.lastActivity ?? new Date(),
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
      tools: null,
      mcpServers: null,
    };

    const handle: ProcessHandle = {
      instance,
      conversation: null,
      abortController: null,
      inputController: null,
      pendingPermissions: new Map<string, PendingPermission>(),
      pendingUserQuestions: new Map<string, PendingUserQuestion>(),
      approvedTools: new Set<string>(options.approvedTools ?? []),
      streamingBlocks: [],
    };

    this.handles.set(id, handle);
    this.emit('status', id, INSTANCE_STATUS.WAITING_INPUT);

    // On resume, load messages from SDK session history
    if (options.continueSession && options.sessionId) {
      try {
        const cwd = instance.worktreePath ?? instance.projectPath;
        const sdkMessages = await getSessionMessages(options.sessionId, { dir: cwd });
        const mapped = this.mapSessionMessages(sdkMessages);
        if (mapped.length > 0) {
          instance.messages = mapped;
          console.log(`[stream-process] Loaded ${mapped.length} messages from SDK session`);
        }
      } catch (err) {
        console.log(`[stream-process] Failed to load SDK session history: ${err}`);
      }
    }

    console.log(`[stream-process] Created instance ${id} for ${options.worktreePath ?? options.projectPath}`);
    return instance;
  }

  // -------------------------------------------------------------------------
  // sendMessage — the core entry point for sending a user prompt
  // -------------------------------------------------------------------------

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

    const instance = handle.instance;
    const cwd = instance.worktreePath ?? instance.projectPath;

    // Sync settings to instance for getAll()
    if (options?.effort) instance.effort = options.effort;
    if (options?.permissionMode) instance.permissionMode = options.permissionMode;

    // Build the display message (hidden messages like permission re-sends skip this)
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
      // Bump last-activity so the history groups by recency of use.
      this.taskStore?.touchActivity(instanceId).catch(err => {
        console.log('[stream-process] touchActivity failed:', err);
      });
    }

    // Build the full prompt with context prepended
    let cliPrompt = prompt;
    if (options?.context && options.context.length > 0) {
      const contextParts = options.context.map(c => {
        switch (c.type) {
          case 'file': return `[File: ${c.label}]\n${c.value}`;
          case 'upload': return `[Attached file: ${c.label}]\nPath: ${c.value}\nUse the Read tool to open it when you need its contents.`;
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

    // If there's already a live conversation, feed the new message into it
    if (handle.conversation && handle.inputController) {
      // Live conversation — update model/permissionMode if changed
      if (options?.model) {
        handle.conversation.setModel(options.model).catch(err => {
          console.log(`[stream-process] Failed to set model: ${err}`);
        });
      }
      if (options?.permissionMode) {
        const sdkMode = this.mapPermissionMode(options.permissionMode);
        handle.conversation.setPermissionMode(sdkMode).catch(err => {
          console.log(`[stream-process] Failed to set permission mode: ${err}`);
        });
      }

      handle.inputController.push({
        type: 'user',
        message: { role: 'user', content: cliPrompt },
        parent_tool_use_id: null,
        session_id: instance.sessionId ?? '',
      });
      return;
    }

    // No existing conversation — start a new one
    const abortController = new AbortController();
    const inputController = new InputController();

    handle.abortController = abortController;
    handle.inputController = inputController;

    // Permission mode mapping
    const sdkPermissionMode = this.mapPermissionMode(options?.permissionMode ?? instance.permissionMode ?? 'ask');

    // Build allowed tools from previously approved tools
    const allowedTools = [...handle.approvedTools];

    // The canUseTool callback — this is the game-changer
    const canUseTool: CanUseTool = async (toolName, input, callbackOptions) => {
      // AskUserQuestion — Claude wants to ask the user something
      if (toolName === 'AskUserQuestion') {
        const questions = (input as { questions?: unknown[] }).questions;
        if (questions && Array.isArray(questions)) {
          return new Promise<PermissionResult>(resolve => {
            const toolUseId = callbackOptions.toolUseID;
            handle.pendingUserQuestions.set(toolUseId, {
              toolUseId,
              questions: questions as PendingUserQuestion['questions'],
              resolve,
            });
            this.emit('user_question', instanceId, {
              toolUseId,
              questions,
            });
          });
        }
        return { behavior: 'allow' as const, updatedInput: input };
      }

      // Already approved tools pass through
      if (handle.approvedTools.has(toolName)) {
        return { behavior: 'allow' as const, updatedInput: input };
      }

      // Emit permission request to frontend, wait for user decision
      return new Promise<PermissionResult>(resolve => {
        const filePath = (input as Record<string, unknown>).file_path as string
          ?? (input as Record<string, unknown>).command as string
          ?? undefined;
        const toolUseId = callbackOptions.toolUseID;

        handle.pendingPermissions.set(toolUseId, {
          toolName,
          toolInput: input as Record<string, unknown>,
          toolUseId,
          filePath,
          title: callbackOptions.title,
          description: callbackOptions.description,
          resolve,
        });

        this.emit('permission_request', instanceId, {
          toolName,
          toolInput: input,
          toolUseId,
          filePath,
          title: callbackOptions.title,
          description: callbackOptions.description,
        });
      });
    };

    // Build SDK options
    const plugins = this.getPluginConfigs();
    const sdkOptions: Parameters<typeof query>[0]['options'] = {
      cwd,
      abortController,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'local'],
      permissionMode: sdkPermissionMode,
      allowedTools,
      canUseTool,
      includePartialMessages: true,
      effort: this.mapEffort(options?.effort ?? instance.effort),
      persistSession: true,
      enableFileCheckpointing: true,
      plugins: plugins.length > 0 ? plugins : undefined,
    };

    if (options?.model ?? instance.model) {
      sdkOptions.model = options?.model ?? instance.model ?? undefined;
    }

    // Resume previous session if we have a sessionId
    if (instance.sessionId) {
      sdkOptions.resume = instance.sessionId;
    }

    // Push the initial message into the input controller
    inputController.push({
      type: 'user',
      message: { role: 'user', content: cliPrompt },
      parent_tool_use_id: null,
      session_id: instance.sessionId ?? '',
    });

    // Start the conversation with the streaming input
    const conversation = query({
      prompt: inputController,
      options: sdkOptions,
    });
    handle.conversation = conversation;

    // Process messages in background
    this.processConversation(instanceId, conversation).catch(err => {
      console.log(`[stream-process] Conversation error for ${instanceId}:`, err);
    });
  }

  // -------------------------------------------------------------------------
  // processConversation — async loop that consumes SDK messages
  // -------------------------------------------------------------------------

  private async processConversation(instanceId: string, conversation: Query): Promise<void> {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    const instance = handle.instance;

    // Use handle.streamingBlocks so in-progress content is accessible
    // when a client re-joins (e.g. tab switch).
    handle.streamingBlocks = [];

    try {
      for await (const msg of conversation) {
        // Instance may have been killed while we were iterating
        if (!this.handles.has(instanceId)) break;

        this.handleSDKMessage(instanceId, msg, handle.streamingBlocks);

        // A `result` message means the turn is complete — flush blocks,
        // persist, and transition to WAITING_INPUT so the user can send
        // the next message.  The loop stays alive for the next turn.
        if (msg.type === 'result') {
          if (handle.streamingBlocks.length > 0) {
            const chatMsg: ChatMessage = {
              role: 'assistant',
              content: handle.streamingBlocks,
              timestamp: new Date().toISOString(),
            };

            // Deduplicate: skip if the text content is identical to the
            // last assistant message (happens when Claude retries denied
            // tools across multiple turns, producing the same response).
            const lastAssistant = [...instance.messages].reverse().find(m => m.role === 'assistant');
            const newText = this.extractText(chatMsg.content);
            const prevText = lastAssistant ? this.extractText(lastAssistant.content) : '';
            const isDuplicate = newText.length > 0 && newText === prevText;

            if (!isDuplicate) {
              instance.messages.push(chatMsg);
              this.emit('message', instanceId, chatMsg);
            }
            handle.streamingBlocks = [];
          }

          instance.status = INSTANCE_STATUS.WAITING_INPUT;
          instance.lastActivity = new Date();
          this.emit('status', instanceId, INSTANCE_STATUS.WAITING_INPUT);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.log(`[stream-process] Conversation aborted for ${instanceId}`);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(`[stream-process] Conversation error for ${instanceId}:`, errorMsg);
        this.emit('error', instanceId, errorMsg);
      }
    }

    // Flush any remaining blocks on conversation end (with dedup)
    if (handle.streamingBlocks.length > 0) {
      const chatMsg: ChatMessage = {
        role: 'assistant',
        content: handle.streamingBlocks,
        timestamp: new Date().toISOString(),
      };
      const lastAssistant = [...instance.messages].reverse().find(m => m.role === 'assistant');
      const newText = this.extractText(chatMsg.content);
      const prevText = lastAssistant ? this.extractText(lastAssistant.content) : '';
      if (!(newText.length > 0 && newText === prevText)) {
        instance.messages.push(chatMsg);
        this.emit('message', instanceId, chatMsg);
      }
      handle.streamingBlocks = [];
    }

    // Conversation has ended (closed, killed, or errored) — clean up
    handle.conversation = null;
    handle.abortController = null;
    handle.inputController = null;

    if (instance.status !== INSTANCE_STATUS.EXITED) {
      instance.status = INSTANCE_STATUS.WAITING_INPUT;
      instance.lastActivity = new Date();
      this.emit('status', instanceId, INSTANCE_STATUS.WAITING_INPUT);
    }
  }

  // -------------------------------------------------------------------------
  // handleSDKMessage — maps SDK events to our internal events
  // -------------------------------------------------------------------------

  private handleSDKMessage(instanceId: string, msg: SDKMessage, assistantBlocks: ContentBlock[]): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    const instance = handle.instance;

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          if (msg.session_id) instance.sessionId = msg.session_id;
          // Only set model from the SDK init if we don't already have one
          // chosen by the user. The SDK returns resolved names (e.g.
          // claude-sonnet-4-6[1m]) but our dropdown works in aliases
          // (sonnet[1m]) — overwriting here breaks the dropdown lookup.
          if (msg.model && !instance.model) instance.model = msg.model;
          if (msg.permissionMode) instance.permissionMode = msg.permissionMode;
          if (msg.tools) instance.tools = msg.tools;
          if (msg.mcp_servers) instance.mcpServers = msg.mcp_servers;
          if (msg.slash_commands) {
            this.cachedSlashCommands = msg.slash_commands;
          }
          this.emit('session', instanceId, {
            sessionId: msg.session_id,
            model: msg.model,
            tools: msg.tools,
            mcpServers: msg.mcp_servers,
            permissionMode: msg.permissionMode,
            cliVersion: msg.claude_code_version,
            slashCommands: msg.slash_commands,
          });
        } else if (msg.subtype === 'task_started') {
          const m = msg as SDKMessage & { task_id: string; tool_use_id?: string; description: string; task_type?: string };
          this.emit('agent_event', instanceId, {
            event: 'started',
            taskId: m.task_id,
            toolUseId: m.tool_use_id,
            description: m.description,
            taskType: m.task_type,
          });
        } else if (msg.subtype === 'task_progress') {
          const m = msg as SDKMessage & { task_id: string; tool_use_id?: string; description: string; last_tool_name?: string; usage?: unknown };
          this.emit('agent_event', instanceId, {
            event: 'progress',
            taskId: m.task_id,
            toolUseId: m.tool_use_id,
            description: m.description,
            lastToolName: m.last_tool_name,
            usage: m.usage,
          });
        } else if (msg.subtype === 'task_notification') {
          const m = msg as SDKMessage & { task_id: string; tool_use_id?: string; status: string; summary: string; usage?: unknown };
          this.emit('agent_event', instanceId, {
            event: 'completed',
            taskId: m.task_id,
            toolUseId: m.tool_use_id,
            status: m.status,
            description: m.summary,
            usage: m.usage,
          });
        }
        break;
      }

      case 'tool_progress': {
        // Real-time tool execution progress (e.g. "Reading file...", "Running bash for 12s...")
        const tp = msg as unknown as {
          tool_use_id: string; tool_name: string;
          elapsed_time_seconds: number; task_id?: string;
        };
        this.emit('tool_progress', instanceId, {
          toolUseId: tp.tool_use_id,
          toolName: tp.tool_name,
          elapsedSeconds: tp.elapsed_time_seconds,
          taskId: tp.task_id,
        });
        break;
      }

      case 'assistant': {
        // Accumulate content blocks within the turn — do NOT flush here.
        // Flushing happens on `result` so all tool calls in a turn are
        // grouped into a single ChatMessage on the frontend.
        const content = msg.message?.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            const mapped = this.mapContentBlock(block);
            assistantBlocks.push(mapped);
            this.emit('content_block', instanceId, mapped);
          }
        }
        break;
      }

      case 'user': {
        // User messages include tool results — forward them
        const content = msg.message?.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            const b = block as unknown as Record<string, unknown>;
            if (b.type === 'tool_result') {
              const mapped: ContentBlock = {
                type: 'tool_result',
                tool_use_id: b.tool_use_id as string,
                content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
                is_error: b.is_error as boolean | undefined,
              };
              // Enrich with structured data from tool_use_result if available
              const toolResult = (msg as Record<string, unknown>).tool_use_result;
              if (toolResult && typeof toolResult === 'object') {
                const tur = toolResult as Record<string, unknown>;
                if (tur.stdout !== undefined) mapped.stdout = tur.stdout as string;
                if (tur.stderr !== undefined) mapped.stderr = tur.stderr as string;
                if (tur.structuredPatch !== undefined) mapped.structuredPatch = tur.structuredPatch;
              }
              assistantBlocks.push(mapped);
              this.emit('content_block', instanceId, mapped);
            }
          }
        }
        break;
      }

      case 'stream_event': {
        // Partial streaming events for real-time text display
        const event = (msg as Record<string, unknown>).event as Record<string, unknown> | undefined;
        if (!event) break;

        const eventType = event.type as string;
        if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            this.emit('stream_delta', instanceId, { text: delta.text as string });
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            this.emit('stream_delta', instanceId, { thinking: delta.thinking as string });
          }
        } else if (eventType === 'content_block_start') {
          const contentBlock = event.content_block as Record<string, unknown> | undefined;
          this.emit('stream_delta', instanceId, {
            type: 'start',
            blockType: contentBlock?.type as string,
            blockName: contentBlock?.name as string,
          });
        } else if (eventType === 'content_block_stop') {
          this.emit('stream_delta', instanceId, { type: 'stop' });
        }
        break;
      }

      case 'result': {
        const costUsd = msg.total_cost_usd ?? 0;
        const inputTokens = msg.usage?.input_tokens ?? 0;
        const outputTokens = msg.usage?.output_tokens ?? 0;

        instance.totalCostUsd += costUsd;
        instance.totalInputTokens += inputTokens;
        instance.totalOutputTokens += outputTokens;

        if (msg.session_id) {
          instance.sessionId = msg.session_id;
        }

        this.emit('result', instanceId, {
          costUsd,
          durationMs: msg.duration_ms,
          stopReason: msg.stop_reason,
          inputTokens,
          outputTokens,
          totalInputTokens: instance.totalInputTokens,
          totalOutputTokens: instance.totalOutputTokens,
        });

        // Emit any permission denials from the result
        if (msg.permission_denials && msg.permission_denials.length > 0) {
          for (const denial of msg.permission_denials) {
            this.emit('permission_request', instanceId, {
              toolName: denial.tool_name,
              toolInput: denial.tool_input,
              toolUseId: denial.tool_use_id,
              filePath: (denial.tool_input as Record<string, unknown>)?.file_path as string
                ?? (denial.tool_input as Record<string, unknown>)?.command as string
                ?? undefined,
            });
          }
        }
        break;
      }

      case 'rate_limit_event': {
        const info = (msg as Record<string, unknown>).rate_limit_info as Record<string, unknown> | undefined;
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

  // -------------------------------------------------------------------------
  // Permission / question resolution from frontend
  // -------------------------------------------------------------------------

  /**
   * Approve a tool for this instance. Also resolves any pending permission
   * callback so the conversation continues immediately.
   */
  approveTool(instanceId: string, toolName: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    handle.approvedTools.add(toolName);
    console.log(`[stream-process] Approved tool '${toolName}' for instance ${instanceId}`);

    // Persist per-task allowlist so it survives restart
    if (this.taskStore) {
      this.taskStore.setApprovedTools(instanceId, [...handle.approvedTools]).catch(err => {
        console.log(`[stream-process] Failed to persist approved tools: ${err}`);
      });
    }

    // Resolve any pending permission requests for this tool (there may be
    // multiple concurrent ones after an "always allow" click).
    for (const [toolUseId, pending] of handle.pendingPermissions) {
      if (pending.toolName === toolName) {
        handle.pendingPermissions.delete(toolUseId);
        pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
      }
    }
  }

  /** Remove a tool from the per-task allowlist (and persist). */
  revokeTool(instanceId: string, toolName: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;
    handle.approvedTools.delete(toolName);
    console.log(`[stream-process] Revoked tool '${toolName}' for instance ${instanceId}`);
    if (this.taskStore) {
      this.taskStore.setApprovedTools(instanceId, [...handle.approvedTools]).catch(err => {
        console.log(`[stream-process] Failed to persist approved tools: ${err}`);
      });
    }
  }

  /**
   * Resolve a specific pending permission request (by toolUseId).
   */
  resolvePermission(instanceId: string, toolUseId: string, allow: boolean, message?: string): void {
    const handle = this.handles.get(instanceId);
    const pending = handle?.pendingPermissions.get(toolUseId);
    if (!pending) return;

    handle!.pendingPermissions.delete(toolUseId);

    if (allow) {
      pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
    } else {
      pending.resolve({ behavior: 'deny', message: message ?? 'User denied this action' });
    }
  }

  /**
   * Resolve a pending AskUserQuestion — user answered Claude's question.
   */
  resolveUserQuestion(instanceId: string, toolUseId: string, answer: string): void {
    const handle = this.handles.get(instanceId);
    const pending = handle?.pendingUserQuestions.get(toolUseId);
    if (!pending) return;

    handle!.pendingUserQuestions.delete(toolUseId);

    // Return allow with the user's answer injected into the input
    pending.resolve({
      behavior: 'allow',
      updatedInput: { answer },
    });
  }

  getApprovedTools(instanceId: string): Set<string> {
    const handle = this.handles.get(instanceId);
    return handle?.approvedTools ?? new Set();
  }

  /**
   * Get any pending permission requests and user questions for an instance.
   * Used to re-emit state after frontend reconnects. Returns arrays because
   * Claude can have multiple concurrent requests in flight (e.g. from parallel
   * subagents); a single-slot representation would silently drop all but one.
   */
  getPendingState(instanceId: string): {
    pendingPermissions: Array<{ toolName: string; toolInput: Record<string, unknown>; toolUseId: string; filePath?: string; title?: string; description?: string }>;
    pendingUserQuestions: Array<{ toolUseId: string; questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; allowMultiple?: boolean }> }>;
  } {
    const handle = this.handles.get(instanceId);
    if (!handle) return { pendingPermissions: [], pendingUserQuestions: [] };

    return {
      pendingPermissions: Array.from(handle.pendingPermissions.values()).map(pp => ({
        toolName: pp.toolName,
        toolInput: pp.toolInput,
        toolUseId: pp.toolUseId,
        filePath: pp.filePath,
        title: pp.title,
        description: pp.description,
      })),
      pendingUserQuestions: Array.from(handle.pendingUserQuestions.values()).map(pq => ({
        toolUseId: pq.toolUseId,
        questions: pq.questions,
      })),
    };
  }

  /**
   * Get in-progress content blocks for the current turn.
   * Used to restore streaming state when a client re-joins (tab switch).
   */
  getStreamingBlocks(instanceId: string): ContentBlock[] {
    const handle = this.handles.get(instanceId);
    return handle ? [...handle.streamingBlocks] : [];
  }

  // -------------------------------------------------------------------------
  // Instance management
  // -------------------------------------------------------------------------

  getAll(): StreamInstance[] {
    return Array.from(this.handles.values()).map(h => ({
      ...h.instance,
      messages: [],
    }));
  }

  /**
   * Re-prefetch slash commands for every distinct cwd that has an active
   * instance, then broadcast the fresh list through the existing `session`
   * event channel. Called after plugin install/uninstall so the `/` autocomplete
   * picks up new commands without restarting the app or spinning the chat loader.
   *
   * Spawns at most one short-lived SDK query per distinct cwd (maxInstances-bounded).
   */
  async refreshSlashCommandsForAllActive(): Promise<void> {
    const cwdToInstances = new Map<string, string[]>();
    for (const [id, handle] of this.handles.entries()) {
      const cwd = handle.instance.worktreePath ?? handle.instance.projectPath;
      const list = cwdToInstances.get(cwd) ?? [];
      list.push(id);
      cwdToInstances.set(cwd, list);
    }
    if (cwdToInstances.size === 0) return;

    this.invalidatePrefetchCache();

    await Promise.allSettled(
      Array.from(cwdToInstances.entries()).map(async ([cwd, ids]) => {
        try {
          const result = await this.prefetchForCwd(cwd);
          for (const id of ids) {
            this.emit('session', id, {
              slashCommands: result.slashCommands,
              tools: result.tools,
              mcpServers: result.mcpServers,
            });
          }
          console.log(`[stream-process] Refreshed slash commands for ${cwd} (${result.slashCommands.length} cmds) → ${ids.length} instance(s)`);
        } catch (err) {
          console.log(`[stream-process] Slash command refresh failed for ${cwd}:`, err);
        }
      }),
    );
  }

  /**
   * Push `/reload-plugins` into every idle live conversation so Claude Code
   * picks up newly installed/uninstalled plugins without restarting the app.
   * Conversations that are currently processing are skipped — queueing a
   * slash command behind a real turn tends to confuse the SDK. Returns the
   * list of instanceIds the command was sent to.
   */
  reloadPluginsInAllActive(): string[] {
    const reloaded: string[] = [];
    for (const [id, handle] of this.handles.entries()) {
      if (!handle.conversation || !handle.inputController) continue;
      if (handle.instance.status !== INSTANCE_STATUS.WAITING_INPUT) continue;
      try {
        handle.inputController.push({
          type: 'user',
          message: { role: 'user', content: '/reload-plugins' },
          parent_tool_use_id: null,
          session_id: handle.instance.sessionId ?? '',
        });
        reloaded.push(id);
        console.log(`[stream-process] /reload-plugins sent to instance ${id}`);
      } catch (err) {
        console.log(`[stream-process] Failed to send /reload-plugins to ${id}:`, err);
      }
    }
    return reloaded;
  }

  get(instanceId: string): StreamInstance | undefined {
    const handle = this.handles.get(instanceId);
    return handle ? { ...handle.instance } : undefined;
  }

  getMessages(instanceId: string): ChatMessage[] {
    const handle = this.handles.get(instanceId);
    return handle ? [...handle.instance.messages] : [];
  }

  /**
   * Update model / effort / permissionMode for an instance. Persists to the
   * in-memory instance and — if a conversation is live — applies to the SDK.
   */
  async updateSettings(instanceId: string, settings: {
    model?: string;
    effort?: string;
    permissionMode?: string;
  }): Promise<void> {
    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error(`Instance ${instanceId} not found`);
    const instance = handle.instance;

    if (settings.model !== undefined) instance.model = settings.model;
    if (settings.effort !== undefined) instance.effort = settings.effort;
    if (settings.permissionMode !== undefined) instance.permissionMode = settings.permissionMode;

    if (handle.conversation) {
      if (settings.model) {
        handle.conversation.setModel(settings.model).catch(err => {
          console.log(`[stream-process] setModel failed: ${err}`);
        });
      }
      if (settings.permissionMode) {
        const sdkMode = this.mapPermissionMode(settings.permissionMode);
        handle.conversation.setPermissionMode(sdkMode).catch(err => {
          console.log(`[stream-process] setPermissionMode failed: ${err}`);
        });
      }
    }

    if (this.taskStore) {
      await this.taskStore.updateSettings(instanceId, {
        model: settings.model,
        effort: settings.effort,
        permissionMode: settings.permissionMode,
      });
    }
  }

  /**
   * Interrupt the current generation.
   */
  interrupt(instanceId: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error(`Instance ${instanceId} not found`);
    if (!handle.conversation) return;

    console.log(`[stream-process] Interrupting instance ${instanceId}`);
    handle.conversation.interrupt().catch(err => {
      console.log(`[stream-process] Interrupt error: ${err}`);
    });
  }

  /**
   * Get context window usage breakdown from the SDK.
   */
  async getContextUsage(instanceId: string): Promise<unknown> {
    const handle = this.handles.get(instanceId);
    if (!handle?.conversation) return null;
    try {
      return await handle.conversation.getContextUsage();
    } catch {
      return null;
    }
  }

  /**
   * Get available models from the SDK.
   */
  async getSupportedModels(instanceId: string): Promise<unknown[]> {
    const handle = this.handles.get(instanceId);
    if (!handle?.conversation) return [];
    try {
      return await handle.conversation.supportedModels();
    } catch {
      return [];
    }
  }

  /**
   * Rewind files to their state at a specific user message.
   * Requires enableFileCheckpointing to be true (set in SDK options).
   */
  async rewindFiles(instanceId: string, userMessageId: string, dryRun = false): Promise<unknown> {
    const handle = this.handles.get(instanceId);
    if (!handle?.conversation) throw new Error('No active conversation');
    return handle.conversation.rewindFiles(userMessageId, { dryRun });
  }

  clearSession(instanceId: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle) return;

    // Close existing conversation if any
    if (handle.conversation) {
      handle.conversation.close();
      handle.conversation = null;
    }
    if (handle.inputController) {
      handle.inputController.end();
      handle.inputController = null;
    }
    handle.abortController = null;

    handle.instance.sessionId = null;
    handle.instance.messages = [];
    handle.approvedTools.clear();
    for (const p of handle.pendingPermissions.values()) {
      p.resolve({ behavior: 'deny', message: 'Session cleared' });
    }
    handle.pendingPermissions.clear();
    for (const q of handle.pendingUserQuestions.values()) {
      q.resolve({ behavior: 'deny', message: 'Session cleared' });
    }
    handle.pendingUserQuestions.clear();
    handle.instance.status = INSTANCE_STATUS.WAITING_INPUT;
    this.emit('status', instanceId, INSTANCE_STATUS.WAITING_INPUT);
    console.log(`[stream-process] Session cleared for instance ${instanceId}`);
  }

  async kill(instanceId: string): Promise<void> {
    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error(`Instance ${instanceId} not found`);

    // Close the SDK conversation
    if (handle.conversation) {
      handle.conversation.close();
    }
    if (handle.inputController) {
      handle.inputController.end();
    }

    // Reject any pending permissions/questions
    for (const p of handle.pendingPermissions.values()) {
      p.resolve({ behavior: 'deny', message: 'Instance killed' });
    }
    handle.pendingPermissions.clear();
    for (const q of handle.pendingUserQuestions.values()) {
      q.resolve({ behavior: 'deny', message: 'Instance killed' });
    }
    handle.pendingUserQuestions.clear();

    handle.instance.status = INSTANCE_STATUS.EXITED;
    this.emit('status', instanceId, INSTANCE_STATUS.EXITED);
    this.emit('exited', instanceId, 0);
    this.handles.delete(instanceId);
  }

  async killAll(): Promise<void> {
    const ids = Array.from(this.handles.keys());
    await Promise.all(ids.map(id => this.kill(id)));
  }

  /** Shut down all instances without emitting exit events (for graceful restart) */
  async shutdownAll(): Promise<void> {
    // Mark as shutting down so exited events don't persist task exit status
    // (we want tasks to remain 'active' so they auto-resume on next startup)
    this.shuttingDown = true;
    for (const [id, handle] of this.handles) {
      if (handle.conversation) handle.conversation.close();
      if (handle.inputController) handle.inputController.end();
      for (const p of handle.pendingPermissions.values()) {
        p.resolve({ behavior: 'deny', message: 'Server shutting down' });
      }
      handle.pendingPermissions.clear();
      for (const q of handle.pendingUserQuestions.values()) {
        q.resolve({ behavior: 'deny', message: 'Server shutting down' });
      }
      handle.pendingUserQuestions.clear();
      this.handles.delete(id);
    }
  }

  /** True during graceful shutdown — prevents tasks from being marked as exited */
  shuttingDown = false;

  /**
   * Wait for the current conversation turn to finish (if any).
   * Resolves immediately if idle.
   */
  waitForIdle(instanceId: string, timeoutMs = 30000): Promise<void> {
    const handle = this.handles.get(instanceId);
    if (!handle) return Promise.reject(new Error(`Instance ${instanceId} not found`));
    if (!handle.conversation) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('status', onStatus);
        reject(new Error('Timed out waiting for idle'));
      }, timeoutMs);

      const onStatus = (id: string, status: string) => {
        if (id === instanceId && status === INSTANCE_STATUS.WAITING_INPUT) {
          clearTimeout(timer);
          this.removeListener('status', onStatus);
          resolve();
        }
      };
      this.on('status', onStatus);
    });
  }

  // -------------------------------------------------------------------------
  // Session history — read from SDK JSONL files
  // -------------------------------------------------------------------------

  /**
   * Load message history from the SDK session files.
   * Falls back to in-memory messages for live instances.
   */
  async getSessionHistory(instanceId: string): Promise<ChatMessage[]> {
    const handle = this.handles.get(instanceId);
    if (!handle) return [];

    const instance = handle.instance;

    // If there are in-memory messages (live session), return those
    if (instance.messages.length > 0) {
      return [...instance.messages];
    }

    // Otherwise read from SDK session JSONL
    if (!instance.sessionId) return [];

    try {
      const cwd = instance.worktreePath ?? instance.projectPath;
      const sdkMessages = await getSessionMessages(instance.sessionId, { dir: cwd });
      const mapped = this.mapSessionMessages(sdkMessages);
      // Cache into instance so subsequent calls are fast
      instance.messages = mapped;
      return mapped;
    } catch (err) {
      console.log(`[stream-process] Failed to load session history for ${instanceId}:`, err);
      return [];
    }
  }


  /**
   * Map SDK SessionMessage[] to our ChatMessage[] format.
   * Groups adjacent assistant blocks into single messages.
   */
  private mapSessionMessages(sdkMessages: SessionMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of sdkMessages) {
      if (msg.type === 'system') continue;

      const raw = msg.message as Record<string, unknown> | undefined;
      if (!raw) continue;

      const role = msg.type as 'user' | 'assistant';
      const rawContent = raw.content;

      const blocks: ContentBlock[] = [];

      // Skip slash-command and internal SDK messages (stored with XML-like tags)
      const isInternalMessage = (text: string) =>
        /<command-name>/.test(text) || /<local-command-stdout>/.test(text) || /<command-message>/.test(text);

      if (typeof rawContent === 'string') {
        if (!isInternalMessage(rawContent)) {
          blocks.push({ type: 'text', text: rawContent });
        }
      } else if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text') {
            if (isInternalMessage(b.text as string)) continue;
            blocks.push({ type: 'text', text: b.text as string });
          } else if (b.type === 'thinking') {
            blocks.push({ type: 'thinking', thinking: b.thinking as string });
          } else if (b.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              tool_use_id: b.id as string,
              name: b.name as string,
              input: b.input,
            });
          } else if (b.type === 'tool_result') {
            blocks.push({
              type: 'tool_result',
              tool_use_id: b.tool_use_id as string,
              content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
              is_error: b.is_error as boolean | undefined,
            });
          }
        }
      }

      if (blocks.length > 0) {
        result.push({ role, content: blocks, timestamp: '' });
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Extract concatenated text from content blocks for dedup comparison */
  private extractText(blocks: ContentBlock[]): string {
    return blocks
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('');
  }

  private mapPermissionMode(mode: string): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' {
    switch (mode) {
      case 'plan': return 'plan';
      case 'ask': return 'default';
      case 'default': return 'default';
      case 'auto-edit': return 'acceptEdits';
      case 'acceptEdits': return 'acceptEdits';
      case 'full-access': return 'bypassPermissions';
      case 'bypassPermissions': return 'bypassPermissions';
      default: return 'default';
    }
  }

  private mapEffort(effort: string | null | undefined): 'low' | 'medium' | 'high' | undefined {
    switch (effort) {
      case 'light': return 'low';
      case 'low': return 'low';
      case 'medium': return 'medium';
      case 'extended': return 'high';
      case 'high': return 'high';
      default: return undefined;
    }
  }

  private mapContentBlock(block: BetaContentBlock): ContentBlock {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        tool_use_id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    if (block.type === 'thinking') {
      return { type: 'thinking', thinking: block.thinking };
    }
    // Fallback for other block types
    return { type: 'text', text: '' };
  }
}

export { INSTANCE_STATUS };
export type { StreamInstance, InstanceStatus, SpawnOptions, ChatMessage, ContentBlock };
