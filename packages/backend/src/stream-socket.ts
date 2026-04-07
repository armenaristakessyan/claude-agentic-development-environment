import type { Server, Socket } from 'socket.io';
import type { StreamProcessManager, ChatMessage, ContentBlock } from './stream-process.js';
import type { TaskStore } from './task-store.js';

function instanceRoom(instanceId: string): string {
  return `instance:${instanceId}`;
}

export function setupStreamSocketHandlers(
  io: Server,
  streamProcess: StreamProcessManager,
  taskStore: TaskStore,
): void {
  // Forward real-time text streaming deltas — scoped to instance room
  streamProcess.on('stream_delta', (instanceId: string, data: {
    text?: string; thinking?: string; type?: string; blockType?: string; blockName?: string;
  }) => {
    io.to(instanceRoom(instanceId)).emit('chat:stream_delta', { instanceId, ...data });
  });

  // Forward tool progress events — scoped to instance room
  streamProcess.on('tool_progress', (instanceId: string, data: {
    toolUseId: string; toolName: string; elapsedSeconds: number; taskId?: string;
  }) => {
    io.to(instanceRoom(instanceId)).emit('chat:tool_progress', { instanceId, ...data });
  });

  // Forward rate limit events — scoped to instance room
  streamProcess.on('rate_limit', (instanceId: string, data: {
    status: string; resetsAt?: number; rateLimitType?: string;
  }) => {
    io.to(instanceRoom(instanceId)).emit('chat:rate_limit', { instanceId, ...data });
  });

  // Forward agent task events — broadcast (sidebar needs this for all instances)
  streamProcess.on('agent_event', (instanceId: string, data: {
    event: string; taskId?: string; toolUseId?: string;
    description?: string; taskType?: string; status?: string;
    lastToolName?: string; usage?: unknown;
  }) => {
    io.emit('agent:event', { instanceId, ...data });
  });

  // Forward status changes — broadcast to ALL clients (sidebar needs this)
  streamProcess.on('status', (instanceId: string, status: string) => {
    io.emit('instance:status', { instanceId, status });
  });

  // Forward new messages — scoped to instance room
  streamProcess.on('message', (instanceId: string, message: ChatMessage) => {
    io.to(instanceRoom(instanceId)).emit('chat:message', { instanceId, message });
  });

  // Forward real-time content blocks — scoped to instance room
  // Also broadcast a lightweight activity hint globally (for sidebar last-action display)
  streamProcess.on('content_block', (instanceId: string, block: ContentBlock) => {
    io.to(instanceRoom(instanceId)).emit('chat:content_block', { instanceId, block });

    if (block.type === 'tool_use' && block.name) {
      const inp = block.input as Record<string, unknown> | null;
      const detail = inp?.file_path as string ?? inp?.command as string ?? inp?.pattern as string ?? inp?.description as string ?? undefined;
      io.emit('instance:activity', { instanceId, toolName: block.name, detail });
    }
  });

  // Forward session info — scoped to instance room + persist sessionId + model
  streamProcess.on('session', (instanceId: string, data: {
    sessionId?: string; model?: string;
    tools?: string[]; mcpServers?: { name: string; status: string }[];
    permissionMode?: string; cliVersion?: string;
    slashCommands?: string[];
  }) => {
    io.to(instanceRoom(instanceId)).emit('chat:session', { instanceId, ...data });
    if (data.sessionId) {
      taskStore.updateSessionId(instanceId, data.sessionId).catch(err => {
        console.log('[stream-socket] Failed to persist sessionId:', err);
      });
    }
    if (data.model) {
      taskStore.updateSettings(instanceId, { model: data.model }).catch(err => {
        console.log('[stream-socket] Failed to persist model:', err);
      });
    }
  });

  // Forward result info — broadcast globally (sidebar cost/token display needs this)
  streamProcess.on('result', (instanceId: string, data: {
    costUsd: number; durationMs: number; stopReason: string;
    inputTokens: number; outputTokens: number;
    totalInputTokens: number; totalOutputTokens: number;
  }) => {
    io.emit('chat:result', { instanceId, ...data });
    // Persist stats
    taskStore.updateStats(instanceId, {
      costUsd: data.costUsd ?? 0,
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
    }).catch((err: unknown) => {
      console.log('[stream-socket] Failed to persist stats:', err);
    });
  });

  // Forward user questions (AskUserQuestion tool) — scoped to instance room
  streamProcess.on('user_question', (instanceId: string, data: {
    toolUseId: string;
    questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      allowMultiple?: boolean;
    }>;
  }) => {
    io.to(instanceRoom(instanceId)).emit('chat:user_question', { instanceId, ...data });
  });

  // Forward permission requests — scoped to instance room
  streamProcess.on('permission_request', (instanceId: string, data: { toolName: string; toolInput: unknown; toolUseId: string }) => {
    io.to(instanceRoom(instanceId)).emit('chat:permission_request', { instanceId, ...data });
  });

  // Forward conversation errors — scoped to instance room
  streamProcess.on('error', (instanceId: string, error: string) => {
    io.to(instanceRoom(instanceId)).emit('chat:error', { instanceId, error });
  });

  // Forward exit — broadcast to ALL clients
  streamProcess.on('exited', (instanceId: string, exitCode: number) => {
    io.emit('instance:exited', { instanceId, exitCode });
    taskStore.markExited(instanceId).catch(err => {
      console.log('[stream-socket] Failed to persist task exit:', err);
    });
  });

  io.on('connection', (socket: Socket) => {
    // Client joins an instance room (to receive scoped events)
    // Re-emit any pending permission request or user question so the
    // frontend picks it up after a page reload or reconnect.
    socket.on('instance:join', ({ instanceId }: { instanceId: string }) => {
      socket.join(instanceRoom(instanceId));

      // Re-emit in-progress streaming blocks so the frontend can restore
      // thinking/tool progress when switching back to a processing tab
      const blocks = streamProcess.getStreamingBlocks(instanceId);
      if (blocks.length > 0) {
        for (const block of blocks) {
          socket.emit('chat:content_block', { instanceId, block });
        }
      }

      const { pendingPermission, pendingUserQuestion } = streamProcess.getPendingState(instanceId);
      if (pendingPermission) {
        socket.emit('chat:permission_request', { instanceId, ...pendingPermission });
      }
      if (pendingUserQuestion) {
        socket.emit('chat:user_question', { instanceId, ...pendingUserQuestion });
      }
    });

    // Client leaves an instance room
    socket.on('instance:leave', ({ instanceId }: { instanceId: string }) => {
      socket.leave(instanceRoom(instanceId));
    });

    // Client approves a tool for an instance (always-allow for this tool)
    socket.on('chat:approve_tool', ({ instanceId, toolName }: { instanceId: string; toolName: string }) => {
      streamProcess.approveTool(instanceId, toolName);
    });

    // Client resolves a specific permission request (allow/deny this one call)
    socket.on('chat:resolve_permission', ({ instanceId, toolUseId, allow, message }: {
      instanceId: string; toolUseId: string; allow: boolean; message?: string;
    }) => {
      streamProcess.resolvePermission(instanceId, toolUseId, allow, message);
    });

    // Client answers an AskUserQuestion from Claude
    socket.on('chat:resolve_question', ({ instanceId, toolUseId, answer }: {
      instanceId: string; toolUseId: string; answer: string;
    }) => {
      streamProcess.resolveUserQuestion(instanceId, toolUseId, answer);
    });

    // Client sends a chat message
    socket.on('chat:send', async ({ instanceId, prompt }: { instanceId: string; prompt: string }) => {
      try {
        await streamProcess.sendMessage(instanceId, prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to send message';
        socket.emit('chat:error', { instanceId, error: message });
      }
    });

    // Client requests message history for an instance
    socket.on('chat:history', async ({ instanceId }: { instanceId: string }) => {
      const messages = await streamProcess.getSessionHistory(instanceId);
      socket.emit('chat:history', { instanceId, messages });
    });
  });
}
