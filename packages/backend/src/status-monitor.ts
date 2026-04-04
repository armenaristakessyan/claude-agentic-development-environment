import type { ProcessManager } from './process-manager.js';
import { INSTANCE_STATUS } from './process-manager.js';

// Strip ANSI escape sequences for clean text matching
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>NOM78cDHZ#]|\x1b\[[\?]?[0-9;]*[hlsr]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// Count printable non-whitespace characters in raw data (visible text only)
function visibleTextLength(data: string): number {
  return stripAnsi(data).replace(/[\r\n\t ]/g, '').length;
}

// ❯ (U+276F) is Claude Code's definitive prompt character.
// Present ONLY when Claude is waiting for user input.
const PROMPT_CHAR = '\u276F';

// Backup patterns for prompt detection
const WAITING_PATTERNS: RegExp[] = [
  /╭─/,                          // Claude Code input box border
  /\(y\/n\)/i,                   // y/n confirmation
  /\(Y\/n\)/,                    // default-yes prompt
  /Press Enter/i,                // press enter prompt
];

export class StatusMonitor {
  // Per-instance: clean text tail for prompt detection
  private tails = new Map<string, string>();
  private readonly TAIL_SIZE = 600;

  // Per-instance: confirmed status (only changes on solid evidence)
  private confirmedStatus = new Map<string, string>();

  // Settle timer: after output stops, re-evaluate
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly SETTLE_MS = 400;

  // Idle tracking
  private lastRealOutputTime = new Map<string, number>();
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_THRESHOLD = 30000;

  constructor(private processManager: ProcessManager) {}

  start(): void {
    // Event-driven: react to every PTY output chunk
    this.processManager.on('output', (instanceId: string, data: string) => {
      this.onOutput(instanceId, data);
    });

    this.processManager.on('exited', (instanceId: string) => {
      this.cleanup(instanceId);
    });

    this.idleCheckInterval = setInterval(() => this.checkIdle(), 5000);
    console.log('[status-monitor] Started (event-driven, prompt-based)');
  }

  stop(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    this.tails.clear();
    this.confirmedStatus.clear();
    this.lastRealOutputTime.clear();
  }

  private onOutput(instanceId: string, data: string): void {
    const instance = this.processManager.get(instanceId);
    if (!instance || instance.status === INSTANCE_STATUS.EXITED) return;

    // Update clean tail
    const clean = stripAnsi(data);
    const existing = this.tails.get(instanceId) ?? '';
    const combined = existing + clean;
    this.tails.set(instanceId,
      combined.length > this.TAIL_SIZE ? combined.slice(-this.TAIL_SIZE) : combined,
    );

    // Launching: transition on first output, checking if prompt is already there
    if (instance.status === INSTANCE_STATUS.LAUNCHING) {
      if (this.hasPrompt(clean) || this.hasPrompt(this.tails.get(instanceId) ?? '')) {
        this.setStatus(instanceId, INSTANCE_STATUS.WAITING_INPUT);
      } else {
        this.setStatus(instanceId, INSTANCE_STATUS.PROCESSING);
      }
      return;
    }

    const confirmed = this.confirmedStatus.get(instanceId);

    // Classify this chunk: is it real content or just animation/cursor noise?
    // Void goose animation frames are ~71 bytes with only 1-2 visible chars.
    // Real content (tool output, code, thinking) has substantial visible text.
    const visibleLen = visibleTextLength(data);
    const isRealContent = visibleLen > 6;

    if (isRealContent) {
      this.lastRealOutputTime.set(instanceId, Date.now());
    }

    // If chunk itself contains the prompt character → waiting (immediate)
    if (clean.includes(PROMPT_CHAR)) {
      this.setStatus(instanceId, INSTANCE_STATUS.WAITING_INPUT);
      // Still set settle timer in case more comes
      this.resetSettle(instanceId);
      return;
    }

    // If currently waiting and this is just animation noise → stay waiting
    if (confirmed === INSTANCE_STATUS.WAITING_INPUT && !isRealContent) {
      // Don't flicker. Animation frames shouldn't change status.
      return;
    }

    // If currently waiting and we see real content without a prompt → processing
    if (confirmed === INSTANCE_STATUS.WAITING_INPUT && isRealContent) {
      this.setStatus(instanceId, INSTANCE_STATUS.PROCESSING);
      this.resetSettle(instanceId);
      return;
    }

    // If currently processing → stay processing, debounce re-check
    this.resetSettle(instanceId);
  }

  private resetSettle(instanceId: string): void {
    const existing = this.settleTimers.get(instanceId);
    if (existing) clearTimeout(existing);

    this.settleTimers.set(instanceId, setTimeout(() => {
      this.settleTimers.delete(instanceId);
      this.evaluateTail(instanceId);
    }, this.SETTLE_MS));
  }

  private evaluateTail(instanceId: string): void {
    const instance = this.processManager.get(instanceId);
    if (!instance || instance.status === INSTANCE_STATUS.EXITED) return;
    if (instance.status === INSTANCE_STATUS.LAUNCHING) return;

    const tail = this.tails.get(instanceId) ?? '';

    if (this.hasPrompt(tail)) {
      this.setStatus(instanceId, INSTANCE_STATUS.WAITING_INPUT);
    }
    // If no prompt found after settle, stay in current state (don't flicker)
  }

  private hasPrompt(text: string): boolean {
    // Primary: the ❯ prompt character
    if (text.includes(PROMPT_CHAR)) return true;

    // Backup patterns
    for (const pattern of WAITING_PATTERNS) {
      if (pattern.test(text)) return true;
    }

    return false;
  }

  private setStatus(instanceId: string, status: string): void {
    const current = this.confirmedStatus.get(instanceId);
    if (current === status) return;

    this.confirmedStatus.set(instanceId, status);
    this.processManager.updateStatus(instanceId, status as 'launching' | 'processing' | 'waiting_input' | 'idle' | 'exited');
  }

  private checkIdle(): void {
    const now = Date.now();
    for (const [instanceId, status] of this.confirmedStatus) {
      if (status !== INSTANCE_STATUS.WAITING_INPUT) continue;

      const lastReal = this.lastRealOutputTime.get(instanceId);
      if (!lastReal) continue;

      if (now - lastReal > this.IDLE_THRESHOLD) {
        this.setStatus(instanceId, INSTANCE_STATUS.IDLE);
      }
    }
  }

  private cleanup(instanceId: string): void {
    this.tails.delete(instanceId);
    this.confirmedStatus.delete(instanceId);
    this.lastRealOutputTime.delete(instanceId);
    const timer = this.settleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.settleTimers.delete(instanceId);
    }
  }
}
