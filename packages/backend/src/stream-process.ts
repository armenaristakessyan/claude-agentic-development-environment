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
  /** Pending permission callback (one at a time) */
  pendingPermission: PendingPermission | null;
  /** Pending AskUserQuestion callback */
  pendingUserQuestion: PendingUserQuestion | null;
  /** Per-instance approved tools (for "ask" permission mode) */
  approvedTools: Set<string>;
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

  constructor(private config: AppConfig, private taskStore?: TaskStore) {
    super();
  }

  getSlashCommands(): string[] {
    return this.cachedSlashCommands ?? [];
  }

  /** Pre-fetch slash commands by spawning a short-lived SDK query */
  async prefetchSlashCommands(force = false): Promise<void> {
    if (this.cachedSlashCommands && !force) return;
    try {
      const conversation = query({
        prompt: 'hi',
        options: {
          maxTurns: 0,
          persistSession: false,
        },
      });
      for await (const msg of conversation) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.cachedSlashCommands = msg.slash_commands ?? [];
          console.log(`[stream-process] Pre-fetched ${this.cachedSlashCommands.length} slash commands`);
          break;
        }
      }
      conversation.close();
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
      conversation: null,
      abortController: null,
      inputController: null,
      pendingPermission: null,
      pendingUserQuestion: null,
      approvedTools: new Set<string>(),
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
    }

    // Build the full prompt with context prepended
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
            handle.pendingUserQuestion = {
              toolUseId: callbackOptions.toolUseID,
              questions: questions as PendingUserQuestion['questions'],
              resolve,
            };
            this.emit('user_question', instanceId, {
              toolUseId: callbackOptions.toolUseID,
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

        handle.pendingPermission = {
          toolName,
          toolInput: input,
          toolUseId: callbackOptions.toolUseID,
          filePath,
          title: callbackOptions.title,
          description: callbackOptions.description,
          resolve,
        };

        this.emit('permission_request', instanceId, {
          toolName,
          toolInput: input,
          toolUseId: callbackOptions.toolUseID,
          filePath,
          title: callbackOptions.title,
          description: callbackOptions.description,
        });
      });
    };

    // Build SDK options
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

    let assistantBlocks: ContentBlock[] = [];

    try {
      for await (const msg of conversation) {
        // Instance may have been killed while we were iterating
        if (!this.handles.has(instanceId)) break;

        this.handleSDKMessage(instanceId, msg, assistantBlocks);

        // A `result` message means the turn is complete — flush blocks,
        // persist, and transition to WAITING_INPUT so the user can send
        // the next message.  The loop stays alive for the next turn.
        if (msg.type === 'result') {
          if (assistantBlocks.length > 0) {
            const chatMsg: ChatMessage = {
              role: 'assistant',
              content: assistantBlocks,
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
            assistantBlocks = [];
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

    // Flush any remaining assistant blocks on conversation end (with dedup)
    if (assistantBlocks.length > 0) {
      const chatMsg: ChatMessage = {
        role: 'assistant',
        content: assistantBlocks,
        timestamp: new Date().toISOString(),
      };
      const lastAssistant = [...instance.messages].reverse().find(m => m.role === 'assistant');
      const newText = this.extractText(chatMsg.content);
      const prevText = lastAssistant ? this.extractText(lastAssistant.content) : '';
      if (!(newText.length > 0 && newText === prevText)) {
        instance.messages.push(chatMsg);
        this.emit('message', instanceId, chatMsg);
      }
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
          if (msg.model) instance.model = msg.model;
          if (msg.permissionMode) instance.permissionMode = msg.permissionMode;
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

    // If there's a pending permission for this tool, resolve it
    if (handle.pendingPermission && handle.pendingPermission.toolName === toolName) {
      const pending = handle.pendingPermission;
      handle.pendingPermission = null;
      pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
    }
  }

  /**
   * Resolve a specific pending permission request (by toolUseId).
   */
  resolvePermission(instanceId: string, toolUseId: string, allow: boolean, message?: string): void {
    const handle = this.handles.get(instanceId);
    if (!handle?.pendingPermission) return;
    if (handle.pendingPermission.toolUseId !== toolUseId) return;

    const pending = handle.pendingPermission;
    handle.pendingPermission = null;

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
    if (!handle?.pendingUserQuestion) return;
    if (handle.pendingUserQuestion.toolUseId !== toolUseId) return;

    const pending = handle.pendingUserQuestion;
    handle.pendingUserQuestion = null;

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

  // -------------------------------------------------------------------------
  // Instance management
  // -------------------------------------------------------------------------

  getAll(): StreamInstance[] {
    return Array.from(this.handles.values()).map(h => ({
      ...h.instance,
      messages: [],
    }));
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
    handle.pendingPermission = null;
    handle.pendingUserQuestion = null;
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

    // Reject any pending permission/question
    if (handle.pendingPermission) {
      handle.pendingPermission.resolve({ behavior: 'deny', message: 'Instance killed' });
      handle.pendingPermission = null;
    }
    if (handle.pendingUserQuestion) {
      handle.pendingUserQuestion.resolve({ behavior: 'deny', message: 'Instance killed' });
      handle.pendingUserQuestion = null;
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

      if (typeof rawContent === 'string') {
        blocks.push({ type: 'text', text: rawContent });
      } else if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text') {
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
