import type { Server, Socket } from 'socket.io';
import type { ProcessManager, InstanceContext } from './process-manager.js';
import type { TaskStore } from './task-store.js';

export function setupSocketHandlers(io: Server, processManager: ProcessManager, taskStore?: TaskStore): void {
  // Track which sockets are attached to which instances
  const attachments = new Map<string, Set<string>>(); // instanceId -> Set<socketId>

  // Forward PTY output to attached sockets
  processManager.on('output', (instanceId: string, data: string) => {
    const sockets = attachments.get(instanceId);
    if (!sockets || sockets.size === 0) return;

    for (const socketId of sockets) {
      io.to(socketId).emit('terminal:output', { instanceId, data });
    }
  });

  // Forward status changes to all clients
  processManager.on('status', (instanceId: string, status: string) => {
    io.emit('instance:status', { instanceId, status });
  });

  // Forward exit events to all clients + persist to task store
  processManager.on('exited', (instanceId: string, exitCode: number) => {
    io.emit('instance:exited', { instanceId, exitCode });
    taskStore?.markExited(instanceId).catch(err => {
      console.log('[socket] Failed to persist task exit:', err);
    });
  });

  // Forward context changes to all clients
  processManager.on('context', (instanceId: string, context: InstanceContext) => {
    io.emit('instance:context', { instanceId, ...context });
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[socket] Client connected: ${socket.id}`);

    socket.on('terminal:attach', ({ instanceId }: { instanceId: string }) => {
      console.log(`[socket] ${socket.id} attaching to ${instanceId}`);

      // Send buffer history BEFORE adding to live output stream to avoid duplicates
      try {
        const buffer = processManager.getBuffer(instanceId);
        socket.emit('terminal:history', { instanceId, data: buffer });
      } catch (err) {
        console.log(`[socket] Error getting buffer for ${instanceId}:`, err);
        // Still send empty history so client knows to start accepting live output
        socket.emit('terminal:history', { instanceId, data: '' });
      }

      // Also send current context data on attach
      const context = processManager.getContext(instanceId);
      if (context) {
        socket.emit('instance:context', { instanceId, ...context });
      }

      // THEN track attachment for live output forwarding
      if (!attachments.has(instanceId)) {
        attachments.set(instanceId, new Set());
      }
      attachments.get(instanceId)!.add(socket.id);
    });

    socket.on('terminal:detach', ({ instanceId }: { instanceId: string }) => {
      console.log(`[socket] ${socket.id} detaching from ${instanceId}`);
      attachments.get(instanceId)?.delete(socket.id);
    });

    socket.on('terminal:input', ({ instanceId, data }: { instanceId: string; data: string }) => {
      try {
        processManager.write(instanceId, data);
      } catch (err) {
        console.log(`[socket] Error writing to ${instanceId}:`, err);
      }
    });

    socket.on('terminal:resize', ({ instanceId, cols, rows }: { instanceId: string; cols: number; rows: number }) => {
      try {
        processManager.resize(instanceId, cols, rows);
      } catch (err) {
        console.log(`[socket] Error resizing ${instanceId}:`, err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[socket] Client disconnected: ${socket.id}`);
      // Remove this socket from all attachments
      for (const [, sockets] of attachments) {
        sockets.delete(socket.id);
      }
    });
  });
}
