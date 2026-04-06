import React, { useState, useEffect, useRef, useCallback, useMemo, type MutableRefObject } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Loader, Copy, Check, BookOpen, Pencil, FilePlus, Terminal, Search, FolderSearch, ListChecks, Globe, Link, Bot, Zap, Plus, Sparkles, CornerDownLeft, FileText, GitBranch as GitBranchIcon, GitCommit, FileDiff, Server, Upload, AlertTriangle as AlertTriangleIcon, Square, type LucideIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useSocket } from '../hooks/useSocket';
import type { ChatMessage, ContentBlock, ContextAttachment, SessionInfo } from '../types';


interface SessionMeta {
  sessionId: string | null;
  model: string | null;
  totalCostUsd: number;
  totalDurationMs: number;
  turns: number;
}

interface ContextItem {
  type: 'file' | 'branch' | 'commit' | 'changes';
  label: string;
  value: string; // content or identifier
}

interface MentionResult {
  label: string;
  insertText: string;
  ext: string;
}

/** Map file extension to a short language label and color */
function extInfo(ext: string): { lang: string; color: string } {
  switch (ext) {
    case 'ts': case 'tsx': return { lang: 'TS', color: 'text-blue-300 bg-blue-400/10' };
    case 'js': case 'jsx': return { lang: 'JS', color: 'text-yellow-400 bg-yellow-400/10' };
    case 'py': return { lang: 'PY', color: 'text-emerald-300 bg-green-400/10' };
    case 'rs': return { lang: 'RS', color: 'text-orange-300/80 bg-orange-400/10' };
    case 'go': return { lang: 'GO', color: 'text-cyan-300 bg-cyan-400/10' };
    case 'java': return { lang: 'JV', color: 'text-rose-300 bg-red-400/10' };
    case 'rb': return { lang: 'RB', color: 'text-rose-300 bg-red-400/10' };
    case 'php': return { lang: 'PHP', color: 'text-violet-300 bg-purple-400/10' };
    case 'swift': return { lang: 'SW', color: 'text-orange-300/80 bg-orange-400/10' };
    case 'kt': return { lang: 'KT', color: 'text-violet-300 bg-purple-400/10' };
    case 'c': case 'cpp': case 'h': return { lang: 'C', color: 'text-blue-300 bg-blue-300/10' };
    case 'css': case 'scss': return { lang: 'CSS', color: 'text-pink-300 bg-pink-400/10' };
    case 'html': return { lang: 'HTML', color: 'text-orange-300/80 bg-orange-400/10' };
    case 'json': return { lang: 'JSON', color: 'text-yellow-300 bg-yellow-300/10' };
    case 'md': case 'mdx': return { lang: 'MD', color: 'text-neutral-400 bg-neutral-400/10' };
    case 'yaml': case 'yml': return { lang: 'YML', color: 'text-green-300 bg-green-300/10' };
    case 'toml': return { lang: 'TOML', color: 'text-neutral-400 bg-neutral-400/10' };
    case 'sql': return { lang: 'SQL', color: 'text-blue-300 bg-blue-300/10' };
    case 'sh': case 'bash': case 'zsh': return { lang: 'SH', color: 'text-emerald-300 bg-green-400/10' };
    case 'scala': return { lang: 'SC', color: 'text-red-300 bg-red-300/10' };
    default: return { lang: ext.toUpperCase().slice(0, 3) || 'FILE', color: 'text-neutral-500 bg-neutral-500/10' };
  }
}

interface ParsedSlashCommand {
  raw: string;         // full command as-is (e.g. "agicap:deploy")
  display: string;     // what to show (e.g. "deploy")
  badge: string;       // source badge (e.g. "agicap", "claude")
  badgeColor: string;  // tailwind classes for badge
}

function parseSlashCommand(cmd: string): ParsedSlashCommand {
  const colonIdx = cmd.indexOf(':');
  if (colonIdx > 0) {
    // Prefixed command like "team-name:skill-name" — show skill name, badge = team
    const team = cmd.slice(0, colonIdx);
    const name = cmd.slice(colonIdx + 1);
    return {
      raw: cmd,
      display: name,
      badge: team,
      badgeColor: 'text-violet-300/80 bg-violet-400/10',
    };
  }
  return {
    raw: cmd,
    display: cmd,
    badge: 'claude',
    badgeColor: 'text-orange-300/80 bg-orange-400/10',
  };
}

interface ChatViewProps {
  instanceId: string;
  status: string;
  sendRef?: MutableRefObject<{ sendMessage: (text: string) => void } | null>;
  initialModel?: string | null;
  initialEffort?: string | null;
  initialPermissionMode?: string | null;
  draft?: string;
  onDraftChange?: (value: string) => void;
}

/** Map a full model ID (e.g. "claude-sonnet-4-6") back to our short key */
function modelIdToKey(modelId: string | null | undefined): string {
  if (!modelId) return 'opus';
  if (modelId.includes('sonnet')) return 'sonnet';
  if (modelId.includes('haiku')) return 'haiku';
  return 'opus';
}

export default function ChatView({ instanceId, status, sendRef, initialModel, initialEffort, initialPermissionMode, draft, onDraftChange }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([]);
  const [localInput, setLocalInput] = useState('');
  const input = draft ?? localInput;
  const setInput = onDraftChange ?? setLocalInput;
  const [sending, setSending] = useState(false);
  const [meta, setMeta] = useState<SessionMeta>({ sessionId: null, model: null, totalCostUsd: 0, totalDurationMs: 0, turns: 0 });

  // Input bar settings — initialized from stored task values
  const [selectedModel, setSelectedModel] = useState(() => modelIdToKey(initialModel));
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode ?? 'ask');
  const [effortLevel, setEffortLevel] = useState(initialEffort ?? 'medium');

  // Dropdown open states
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  // Permission request (ask mode)
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; toolInput: unknown; toolUseId: string } | null>(null);

  // User question (AskUserQuestion tool)
  const [pendingQuestion, setPendingQuestion] = useState<{
    toolUseId: string;
    questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      allowMultiple?: boolean;
    }>;
  } | null>(null);

  // Real-time streaming text from stream_delta events
  const [streamingText, setStreamingText] = useState('');
  const deltaBufferRef = useRef('');
  const flushTimerRef = useRef<number | null>(null);

  // Thinking block streaming
  const [thinkingText, setThinkingText] = useState('');
  const thinkingBufferRef = useRef('');
  const thinkingFlushRef = useRef<number | null>(null);

  // Tool progress (real-time: "Running bash for 12s...")
  const [toolProgress, setToolProgress] = useState<{ toolName: string; elapsedSeconds: number } | null>(null);

  // Context usage (token budget)
  const [contextUsage, setContextUsage] = useState<{ usedTokens: number; maxTokens: number } | null>(null);

  // Session info (tools, MCP servers, etc.)
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  // Fetch slash commands from server cache
  const refreshSlashCommands = useCallback(() => {
    fetch('/api/slash-commands')
      .then(res => res.ok ? res.json() as Promise<string[]> : [])
      .then(commands => {
        if (commands.length > 0) {
          setSessionInfo(prev => ({
            sessionId: prev?.sessionId ?? null,
            model: prev?.model ?? null,
            ...prev,
            slashCommands: commands,
          }));
        }
      })
      .catch(() => {});
  }, []);

  // Pre-fetch on mount with retry, + refresh when plugins change
  useEffect(() => {
    refreshSlashCommands();
    // Backend may still be prefetching on cold start — retry a few times
    const retryTimers = [2000, 5000, 10000].map(delay =>
      setTimeout(() => {
        if (!sessionInfo?.slashCommands || sessionInfo.slashCommands.length === 0) {
          refreshSlashCommands();
        }
      }, delay),
    );
    const onPluginsChanged = () => refreshSlashCommands();
    window.addEventListener('plugins-changed', onPluginsChanged);
    return () => {
      retryTimers.forEach(clearTimeout);
      window.removeEventListener('plugins-changed', onPluginsChanged);
    };
  }, [refreshSlashCommands]); // eslint-disable-line react-hooks/exhaustive-deps

  // Context attachments
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [contextPanel, setContextPanel] = useState<string | null>(null); // 'files' | 'branches' | 'commits' | 'changes' | null
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const socket = useSocket();

  // Fetch message history on mount
  useEffect(() => {
    fetch(`/api/instances/${instanceId}/messages`)
      .then(r => r.json())
      .then((msgs: ChatMessage[]) => setMessages(msgs))
      .catch(() => {});
  }, [instanceId]);

  // Listen for real-time events
  useEffect(() => {
    const onMessage = ({ instanceId: id, message }: { instanceId: string; message: ChatMessage }) => {
      if (id !== instanceId) return;
      setMessages(prev => [...prev, message]);
      setStreamingBlocks([]);
      // Clear streaming text when full message arrives (prevents duplication)
      setStreamingText('');
      deltaBufferRef.current = '';
      setThinkingText('');
      thinkingBufferRef.current = '';
      setToolProgress(null);
    };

    const onContentBlock = ({ instanceId: id, block }: { instanceId: string; block: ContentBlock }) => {
      if (id !== instanceId) return;
      setStreamingBlocks(prev => [...prev, block]);
    };

    const onStatus = ({ instanceId: id, status: newStatus }: { instanceId: string; status: string }) => {
      if (id !== instanceId) return;
      if (newStatus === 'waiting_input') {
        setSending(false);
      }
    };

    const onSession = ({ instanceId: id, sessionId, model, tools, mcpServers, permissionMode: pm, cliVersion, slashCommands }: {
      instanceId: string; sessionId?: string; model?: string;
      tools?: string[]; mcpServers?: { name: string; status: string }[];
      permissionMode?: string; cliVersion?: string; slashCommands?: string[];
    }) => {
      if (id !== instanceId) return;
      if (sessionId || model) setMeta(prev => ({ ...prev, sessionId: sessionId ?? prev.sessionId, model: model ?? prev.model }));
      if (tools || mcpServers || slashCommands) {
        setSessionInfo(prev => ({
          sessionId: sessionId ?? prev?.sessionId ?? null,
          model: model ?? prev?.model ?? null,
          tools: tools ?? prev?.tools,
          mcpServers: mcpServers ?? prev?.mcpServers,
          permissionMode: pm ?? prev?.permissionMode,
          cliVersion: cliVersion ?? prev?.cliVersion,
          slashCommands: slashCommands ?? prev?.slashCommands,
        }));
      }
    };

    const onResult = ({ instanceId: id, costUsd, durationMs }: { instanceId: string; costUsd: number; durationMs: number }) => {
      if (id !== instanceId) return;
      setSending(false);
      setToolProgress(null);
      // Fetch context usage after each turn
      fetch(`/api/instances/${instanceId}/context-usage`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && typeof data === 'object' && 'used_tokens' in data) {
            setContextUsage({ usedTokens: data.used_tokens as number, maxTokens: data.max_tokens as number });
          }
        })
        .catch(() => {});
      setMeta(prev => ({
        ...prev,
        totalCostUsd: prev.totalCostUsd + (costUsd ?? 0),
        totalDurationMs: prev.totalDurationMs + (durationMs ?? 0),
        turns: prev.turns + 1,
      }));
    };

    // Join instance room for scoped events
    socket.emit('instance:join', { instanceId });

    const onPermissionRequest = ({ instanceId: id, toolName, toolInput, toolUseId }: {
      instanceId: string; toolName: string; toolInput: unknown; toolUseId: string;
    }) => {
      if (id !== instanceId) return;
      // Skip if this tool was already approved in this session
      if (approvedToolsRef.current.has(toolName)) return;
      setPendingPermission({ toolName, toolInput, toolUseId });
    };

    const onUserQuestion = ({ instanceId: id, toolUseId, questions }: {
      instanceId: string; toolUseId: string;
      questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; allowMultiple?: boolean }>;
    }) => {
      if (id !== instanceId) return;
      setPendingQuestion({ toolUseId, questions });
    };

    // RAF-throttled stream delta handler for real-time text streaming
    const onStreamDelta = ({ instanceId: id, text, thinking, type, blockType }: {
      instanceId: string; text?: string; thinking?: string; type?: string; blockType?: string;
    }) => {
      if (id !== instanceId) return;
      if (text) {
        deltaBufferRef.current += text;
        if (!flushTimerRef.current) {
          flushTimerRef.current = window.requestAnimationFrame(() => {
            const buffered = deltaBufferRef.current;
            deltaBufferRef.current = '';
            flushTimerRef.current = null;
            setStreamingText(prev => prev + buffered);
          });
        }
      }
      if (thinking) {
        thinkingBufferRef.current += thinking;
        if (!thinkingFlushRef.current) {
          thinkingFlushRef.current = window.requestAnimationFrame(() => {
            const buffered = thinkingBufferRef.current;
            thinkingBufferRef.current = '';
            thinkingFlushRef.current = null;
            setThinkingText(prev => prev + buffered);
          });
        }
      }
      if (type === 'start') {
        if (blockType === 'thinking') {
          setThinkingText('');
          thinkingBufferRef.current = '';
        } else {
          setStreamingText('');
          deltaBufferRef.current = '';
        }
      }
    };

    // Tool progress — real-time feedback during long tool runs
    const onToolProgress = ({ instanceId: id, toolName, elapsedSeconds }: {
      instanceId: string; toolName: string; elapsedSeconds: number;
    }) => {
      if (id !== instanceId) return;
      setToolProgress({ toolName, elapsedSeconds });
    };

    socket.on('chat:message', onMessage);
    socket.on('chat:content_block', onContentBlock);
    socket.on('chat:stream_delta', onStreamDelta);
    socket.on('chat:tool_progress', onToolProgress);
    socket.on('instance:status', onStatus);
    socket.on('chat:session', onSession);
    socket.on('chat:result', onResult);
    socket.on('chat:permission_request', onPermissionRequest);
    socket.on('chat:user_question', onUserQuestion);

    socket.emit('chat:history', { instanceId });
    const onHistory = ({ instanceId: id, messages: msgs }: { instanceId: string; messages: ChatMessage[] }) => {
      if (id !== instanceId) return;
      if (msgs.length > 0) setMessages(msgs);
    };
    socket.on('chat:history', onHistory);

    // Re-join room on reconnect
    const onConnect = () => socket.emit('instance:join', { instanceId });
    socket.on('connect', onConnect);

    return () => {
      socket.emit('instance:leave', { instanceId });
      socket.off('chat:message', onMessage);
      socket.off('chat:content_block', onContentBlock);
      socket.off('chat:stream_delta', onStreamDelta);
      socket.off('chat:tool_progress', onToolProgress);
      socket.off('instance:status', onStatus);
      socket.off('chat:session', onSession);
      socket.off('chat:result', onResult);
      socket.off('chat:permission_request', onPermissionRequest);
      socket.off('chat:user_question', onUserQuestion);
      socket.off('chat:history', onHistory);
      socket.off('connect', onConnect);
      // Cancel any pending RAF
      if (flushTimerRef.current) {
        cancelAnimationFrame(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (thinkingFlushRef.current) {
        cancelAnimationFrame(thinkingFlushRef.current);
        thinkingFlushRef.current = null;
      }
    };
  }, [instanceId, socket]);

  // Smart auto-scroll — only scroll when user is near the bottom
  const userScrolledUpRef = useRef(false);

  // Track if user manually scrolled up
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      userScrolledUpRef.current = distFromBottom > 150;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll on new content
  useEffect(() => {
    if (userScrolledUpRef.current) return;
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, streamingBlocks, streamingText]);

  // Add a system message locally


  // Model ID mapping
  const modelIdMap: Record<string, string> = {
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  };

  // Track tools already approved this session to prevent duplicate prompts
  const approvedToolsRef = useRef(new Set<string>());

  // Approve a tool with optional persistence scope, then re-send
  const approveToolPersist = useCallback(async (toolName: string, scope: 'session' | 'project') => {
    approvedToolsRef.current.add(toolName);
    setPendingPermission(null);

    try {
      // First: persist the approval and wait for it to complete
      const allowRes = await fetch(`/api/instances/${instanceId}/allow-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, scope }),
      });
      if (!allowRes.ok) {
        console.error(`[ChatView] allow-tool failed: ${allowRes.status}`);
      }
    } catch (err) {
      console.error('[ChatView] allow-tool request failed:', err);
    }

    // Then: re-send with a simple "continue" — hidden flag prevents duplicate user bubble
    setSending(true);
    try {
      const msgRes = await fetch(`/api/instances/${instanceId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `I have approved the ${toolName} tool. Please continue with what you were doing.`,
          model: modelIdMap[selectedModel],
          permissionMode,
          effort: effortLevel,
          hidden: true,
        }),
      });
      if (!msgRes.ok) {
        console.error(`[ChatView] send message after approval failed: ${msgRes.status}`);
        setSending(false);
      }
    } catch (err) {
      console.error('[ChatView] send message after approval failed:', err);
      setSending(false);
    }
  }, [instanceId, selectedModel, permissionMode, effortLevel]);

  // Dismiss permission prompt without approving
  const dismissPermission = useCallback(() => {
    setPendingPermission(null);
  }, []);

  // Remove a context item
  const removeContext = useCallback((index: number) => {
    setContextItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Build the context payload for the API
  const buildContextPayload = useCallback(() => {
    if (contextItems.length === 0) return undefined;
    return contextItems.map(item => ({
      type: item.type,
      label: item.label,
      value: item.value,
    }));
  }, [contextItems]);

  // Direct send for hotkeys and quick-action buttons
  // force=true bypasses the sending guard (used for permission/question responses)
  const sendDirect = useCallback(async (text: string, force = false) => {
    if ((!force && sending) || status === 'exited') return;
    setSending(true);
    try {
      await fetch(`/api/instances/${instanceId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          model: modelIdMap[selectedModel],
          permissionMode,
          effort: effortLevel,
          context: buildContextPayload(),
        }),
      });
      setContextItems([]);
    } catch {
      setSending(false);
    }
  }, [sending, status, instanceId, selectedModel, permissionMode, effortLevel, buildContextPayload]);

  // Interrupt current generation
  const handleInterrupt = useCallback(async () => {
    try {
      await fetch(`/api/instances/${instanceId}/interrupt`, { method: 'POST' });
      setSending(false);
    } catch { /* ignore */ }
  }, [instanceId]);

  // Handle file upload from the hidden input
  const handleUploadFiles = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        setContextItems(prev => [...prev, { type: 'file', label: file.name, value: `[Image: ${file.name}]\n${dataUrl}` }]);
      } else {
        const text = await file.text();
        setContextItems(prev => [...prev, { type: 'file', label: file.name, value: text }]);
      }
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  }, []);

  // @ mention state for codebase search (files + symbols)
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionResults, setMentionResults] = useState<MentionResult[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionActive, setMentionActive] = useState(false);
  const mentionSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search for @ mentions — files only
  useEffect(() => {
    if (!mentionActive || !mentionQuery) {
      setMentionResults([]);
      return;
    }
    if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current);
    mentionSearchTimer.current = setTimeout(async () => {
      try {
        const q = mentionQuery.toLowerCase();
        const res = await fetch(`/api/instances/${instanceId}/context/files`);
        const data = await res.json() as { files: string[] };
        const results: MentionResult[] = (data.files ?? [])
          .filter(f => f.toLowerCase().includes(q))
          .slice(0, 15)
          .map(f => {
            const ext = f.split('.').pop() ?? '';
            return { label: f, insertText: f, ext };
          });
        setMentionResults(results);
        setMentionIndex(0);
      } catch {
        setMentionResults([]);
      }
    }, 150);
    return () => { if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current); };
  }, [mentionQuery, mentionActive, instanceId]);

  // Submit answer to a user question — sends as the next message
  const submitQuestionAnswer = useCallback((answers: string[]) => {
    const answerText = answers.join(', ');
    setPendingQuestion(null);
    sendDirect(answerText, true);
  }, [sendDirect]);

  // Expose sendMessage to parent via ref
  useEffect(() => {
    if (sendRef) {
      sendRef.current = { sendMessage: sendDirect };
    }
    return () => {
      if (sendRef) sendRef.current = null;
    };
  }, [sendRef, sendDirect]);

  const isProcessing = status === 'processing';

  // Queue for messages sent while processing — delivered after interrupt completes
  const pendingMessageRef = useRef<string | null>(null);

  // When status changes to waiting_input, deliver any pending message
  useEffect(() => {
    if (status === 'waiting_input' && pendingMessageRef.current) {
      const queued = pendingMessageRef.current;
      pendingMessageRef.current = null;
      sendDirect(queued);
    }
  }, [status, sendDirect]);

  const handleSend = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt) return;
    setInput('');

    // /clear resets the session server-side and clears local state
    if (prompt === '/clear' || prompt === '/reset') {
      try {
        await fetch(`/api/instances/${instanceId}/clear`, { method: 'POST' });
        setMessages([]);
        setStreamingBlocks([]);
        setMeta(prev => ({ ...prev, sessionId: null, turns: 0, totalCostUsd: 0, totalDurationMs: 0 }));
      } catch { /* ignore */ }
      return;
    }

    // If currently processing, interrupt and queue the new message
    if (isProcessing) {
      pendingMessageRef.current = prompt;
      await handleInterrupt();
      return;
    }

    setSending(true);
    try {
      await fetch(`/api/instances/${instanceId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          model: modelIdMap[selectedModel],
          permissionMode,
          effort: effortLevel,
          context: buildContextPayload(),
        }),
      });
      setContextItems([]);
    } catch {
      setSending(false);
    }
  }, [input, instanceId, selectedModel, permissionMode, effortLevel, buildContextPayload, isProcessing, handleInterrupt]);

  // Autocomplete from server-provided slash commands
  const [acIndex, setAcIndex] = useState(0);
  const acMatches = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const query = input.slice(1).toLowerCase();
    const commands = sessionInfo?.slashCommands ?? [];
    const filtered = query ? commands.filter(c => c.toLowerCase().includes(query)) : commands;
    return filtered.map(parseSlashCommand);
  }, [input, sessionInfo?.slashCommands]);
  const showAutocomplete = acMatches.length > 0;

  useEffect(() => { setAcIndex(0); }, [acMatches.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @ mention navigation
    if (mentionActive && mentionResults.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(prev => Math.min(prev + 1, mentionResults.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(prev => Math.max(prev - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selected = mentionResults[mentionIndex];
        if (selected) {
          // Replace @query with the selected item
          const cursorPos = inputRef.current?.selectionStart ?? input.length;
          const beforeCursor = input.slice(0, cursorPos);
          const atIdx = beforeCursor.lastIndexOf('@');
          if (atIdx >= 0) {
            const newInput = input.slice(0, atIdx) + '@' + selected.insertText + ' ' + input.slice(cursorPos);
            setInput(newInput);
          }
        }
        setMentionActive(false);
        setMentionQuery('');
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setMentionActive(false); setMentionQuery(''); return; }
    }

    // Slash command autocomplete
    if (showAutocomplete) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex(prev => Math.min(prev + 1, acMatches.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAcIndex(prev => Math.max(prev - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); if (acMatches[acIndex]) setInput(`/${acMatches[acIndex].raw} `); return; }
      if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Detect @ in input to activate mention search
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    const cursorPos = e.target.selectionStart ?? val.length;
    const beforeCursor = val.slice(0, cursorPos);
    const atIdx = beforeCursor.lastIndexOf('@');

    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(beforeCursor[atIdx - 1]))) {
      const query = beforeCursor.slice(atIdx + 1);
      if (!query.includes(' ') && query.length > 0) {
        setMentionActive(true);
        setMentionQuery(query);
      } else {
        setMentionActive(false);
        setMentionQuery('');
      }
    } else {
      setMentionActive(false);
      setMentionQuery('');
    }
  }, [setInput]);

  // Separate streaming blocks into tools and text
  const streamingTools = streamingBlocks.filter(b => b.type === 'tool_use');
  const streamingTextBlocks = streamingBlocks.filter(b => b.type === 'text');


  return (
    <div className="flex h-full flex-col">
      {/* Session info bar */}
      {sessionInfo?.tools && sessionInfo.tools.length > 0 && (
        <div className="shrink-0 border-b border-[#1a1a1a] px-6 py-1.5">
          <div className="mx-auto flex max-w-3xl items-center gap-3 text-[11px] text-neutral-600">
            <span className="flex items-center gap-1">
              <Server className="h-3 w-3" />
              {sessionInfo.tools.length} tools
            </span>
            {sessionInfo.mcpServers && sessionInfo.mcpServers.filter(s => s.status === 'connected').length > 0 && (
              <span className="flex items-center gap-1">
                <Globe className="h-3 w-3" />
                {sessionInfo.mcpServers.filter(s => s.status === 'connected').length} MCP
              </span>
            )}
            {sessionInfo.cliVersion && (
              <span>v{sessionInfo.cliVersion}</span>
            )}
            {contextUsage && contextUsage.maxTokens > 0 && (
              <span className="flex items-center gap-1.5" title={`${contextUsage.usedTokens.toLocaleString()} / ${contextUsage.maxTokens.toLocaleString()} tokens`}>
                <div className="h-1 w-16 overflow-hidden rounded-full bg-[#222]">
                  <div
                    className={`h-full rounded-full transition-all ${
                      contextUsage.usedTokens / contextUsage.maxTokens > 0.9 ? 'bg-rose-400'
                        : contextUsage.usedTokens / contextUsage.maxTokens > 0.7 ? 'bg-amber-400'
                        : 'bg-emerald-400'
                    }`}
                    style={{ width: `${Math.min(100, (contextUsage.usedTokens / contextUsage.maxTokens) * 100)}%` }}
                  />
                </div>
                <span>{Math.round((contextUsage.usedTokens / contextUsage.maxTokens) * 100)}% ctx</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && streamingBlocks.length === 0 && !isProcessing && !streamingText && (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-neutral-600">Start a conversation...</p>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-5">
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}

          {/* Live streaming — single "Working" block */}
          {(isProcessing || streamingBlocks.length > 0 || streamingText) && (
            <LiveWorkingBlock
              tools={streamingTools}
              textBlocks={streamingTextBlocks}
              isProcessing={isProcessing}
              streamingText={streamingText}
              thinkingText={thinkingText}
              toolProgress={toolProgress}
            />
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* User question form (AskUserQuestion tool) */}
      {pendingQuestion && (
        <div className="shrink-0 px-6 py-3">
          <div className="mx-auto max-w-3xl">
            <UserQuestionForm
              questions={pendingQuestion.questions}
              onSubmit={submitQuestionAnswer}
              onSkip={() => { setPendingQuestion(null); sendDirect('skip', true); }}
            />
          </div>
        </div>
      )}

      {/* Permission prompt (ask mode) */}
      {pendingPermission && !pendingQuestion && (
        <PermissionPrompt
          permission={pendingPermission}
          onApproveSession={() => approveToolPersist(pendingPermission.toolName, 'session')}
          onApproveProject={() => approveToolPersist(pendingPermission.toolName, 'project')}
          onReject={() => { dismissPermission(); sendDirect('no, try a different approach', true); }}
        />
      )}



      {/* Input bar */}
      <div className="relative shrink-0">
        <div className="mx-auto max-w-3xl px-6">
          {/* Slash command autocomplete */}
          {showAutocomplete && (
            <div className="absolute bottom-full left-6 right-6 z-20 mb-1">
              <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#141414] shadow-xl">
                <div className="max-h-64 overflow-y-auto py-1">
                  {acMatches.map((cmd, i) => (
                    <button
                      key={cmd.raw}
                      onMouseDown={e => { e.preventDefault(); setInput(`/${cmd.raw} `); }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${i === acIndex ? 'bg-[#1e1e1e]' : 'hover:bg-[#1a1a1a]'}`}
                    >
                      <span className="text-[13px] font-medium text-neutral-300">/{cmd.display}</span>
                      <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${cmd.badgeColor}`}>
                        {cmd.badge}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Context menu dropdown */}
          {contextMenuOpen && !contextPanel && (
            <div className="absolute bottom-full left-6 z-20 mb-1">
              <ContextMenuDropdown
                onClose={() => setContextMenuOpen(false)}
                onOpenPanel={(panel) => {
                  if (panel === 'upload') {
                    setContextMenuOpen(false);
                    uploadInputRef.current?.click();
                  } else {
                    setContextPanel(panel);
                    setContextMenuOpen(false);
                  }
                }}
              />
            </div>
          )}

          {/* Hidden file input for upload */}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.toml,.csv,.log,.sh,.bash,.zsh,.sql,.rb,.php,.swift,.kt,.scala"
            className="hidden"
            onChange={handleUploadFiles}
          />

          {/* Context sub-panel */}
          {contextPanel && contextPanel !== 'upload' && (
            <div className="absolute bottom-full left-6 right-6 z-20 mb-1">
              <div className="mx-auto max-w-3xl">
                <ContextSubPanel
                  panel={contextPanel}
                  instanceId={instanceId}
                  sessionInfo={sessionInfo}
                  onAttach={(item) => {
                    setContextItems(prev => [...prev, item]);
                    setContextPanel(null);
                  }}
                  onClose={() => setContextPanel(null)}
                />
              </div>
            </div>
          )}

          {/* Context chips */}
          {contextItems.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-3 pb-1">
              {contextItems.map((item, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1.5 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[12px] text-neutral-400"
                >
                  {item.type === 'file' && <FileText className="h-3 w-3 text-neutral-600" />}
                  {item.type === 'branch' && <GitBranchIcon className="h-3 w-3 text-neutral-600" />}
                  {item.type === 'commit' && <GitCommit className="h-3 w-3 text-neutral-600" />}
                  {item.type === 'changes' && <FileDiff className="h-3 w-3 text-neutral-600" />}
                  <span className="max-w-[150px] truncate">{item.label}</span>
                  <button
                    onClick={() => removeContext(i)}
                    className="ml-0.5 text-neutral-600 hover:text-neutral-400"
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* @ mention dropdown */}
          {mentionActive && mentionResults.length > 0 && (
            <div className="absolute bottom-full left-6 right-6 z-20 mb-1">
              <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#141414] shadow-xl">
                <div className="max-h-48 overflow-y-auto py-1">
                  {mentionResults.map((item, i) => {
                    const info = extInfo(item.ext);
                    return (
                      <button
                        key={item.insertText}
                        onMouseDown={e => {
                          e.preventDefault();
                          const cursorPos = inputRef.current?.selectionStart ?? input.length;
                          const beforeCursor = input.slice(0, cursorPos);
                          const atIdx = beforeCursor.lastIndexOf('@');
                          if (atIdx >= 0) {
                            const newInput = input.slice(0, atIdx) + '@' + item.insertText + ' ' + input.slice(cursorPos);
                            setInput(newInput);
                          }
                          setMentionActive(false);
                          setMentionQuery('');
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${i === mentionIndex ? 'bg-[#1e1e1e]' : 'hover:bg-[#1a1a1a]'}`}
                      >
                        <span className={`rounded px-1 py-0.5 text-[9px] font-bold leading-none ${info.color}`}>
                          {info.lang}
                        </span>
                        <span className="truncate text-[12px] text-neutral-300">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Textarea row */}
          <div className="flex items-center gap-2 pt-3 pb-2">
            {/* + context button */}
            <button
              onClick={() => {
                if (contextPanel) { setContextPanel(null); }
                else { setContextMenuOpen(prev => !prev); }
                setModelOpen(false); setPermissionOpen(false); setEffortOpen(false);
              }}
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-[#2a2a2a] text-neutral-600 transition-colors hover:border-[#333] hover:text-neutral-400"
            >
              <Plus className="h-4 w-4" />
            </button>

            {/* Input */}
            <div className="flex min-h-[36px] flex-1 rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] px-4 py-[7px]">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Follow-up on this task, @ for mentions, / for commands"
                rows={1}
                disabled={status === 'exited'}
                className="flex-1 resize-none bg-transparent text-[14px] leading-snug text-neutral-300 placeholder-neutral-600 outline-none disabled:opacity-50"
                style={{ minHeight: '20px', maxHeight: '120px' }}
                onInput={e => {
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = '20px';
                  el.style.height = `${el.scrollHeight}px`;
                }}
                onFocus={() => { setContextMenuOpen(false); setModelOpen(false); setPermissionOpen(false); setEffortOpen(false); }}
              />
            </div>
          </div>

          {/* Bottom toolbar row */}
          <div className="flex items-center gap-1 pb-3">
            {/* Model selector */}
            <div className="relative">
              <button
                onClick={() => { setModelOpen(prev => !prev); setPermissionOpen(false); setEffortOpen(false); setContextMenuOpen(false); }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-neutral-500 transition-colors hover:bg-[#1a1a1a] hover:text-neutral-300"
              >
                <Sparkles className="h-3 w-3" />
                <span>{MODEL_OPTIONS.find(m => m.id === selectedModel)?.label ?? 'Sonnet 4.6'}</span>
                <ChevronUp className="h-3 w-3" />
              </button>
              {modelOpen && (
                <DropdownMenu
                  items={MODEL_OPTIONS.map(m => ({
                    id: m.id,
                    label: m.label,
                    sublabel: m.id === 'opus' ? 'Default' : undefined,
                    active: m.id === selectedModel,
                  }))}
                  onSelect={(id) => { setSelectedModel(id); setModelOpen(false); }}
                  onClose={() => setModelOpen(false)}
                  title="Model"
                />
              )}
            </div>

            {/* Permission mode selector */}
            <div className="relative">
              <button
                onClick={() => { setPermissionOpen(prev => !prev); setModelOpen(false); setEffortOpen(false); setContextMenuOpen(false); }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-neutral-500 transition-colors hover:bg-[#1a1a1a] hover:text-neutral-300"
              >
                <span>{PERMISSION_OPTIONS.find(p => p.id === permissionMode)?.label ?? 'Ask Permission'}</span>
                <ChevronUp className="h-3 w-3" />
              </button>
              {permissionOpen && (
                <PermissionDropdown
                  selectedId={permissionMode}
                  onSelect={(id) => { setPermissionMode(id); setPermissionOpen(false); }}
                  onClose={() => setPermissionOpen(false)}
                />
              )}
            </div>

            {/* Effort selector */}
            <div className="relative">
              <button
                onClick={() => { setEffortOpen(prev => !prev); setModelOpen(false); setPermissionOpen(false); setContextMenuOpen(false); }}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-[#1a1a1a] ${
                  effortLevel === 'high' ? 'text-violet-300/70 hover:text-violet-300'
                    : effortLevel === 'medium' ? 'text-blue-300/70 hover:text-blue-300'
                    : 'text-neutral-400/70 hover:text-neutral-300'
                }`}
              >
                <BrainIcon className="h-4 w-4" />
              </button>
              {effortOpen && (
                <DropdownMenu
                  items={EFFORT_OPTIONS.map(e => ({
                    id: e.id,
                    label: e.label,
                    sublabel: e.id === 'medium' ? 'Default' : undefined,
                    active: e.id === effortLevel,
                    icon: <BrainIcon className={`h-3.5 w-3.5 ${
                      e.id === 'high' ? 'text-violet-300'
                        : e.id === 'medium' ? 'text-blue-300'
                        : 'text-neutral-400'
                    }`} />,
                  }))}
                  onSelect={(id) => { setEffortLevel(id); setEffortOpen(false); }}
                  onClose={() => setEffortOpen(false)}
                  title="Effort"
                />
              )}
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Stop / Send button */}
            {isProcessing ? (
              <button
                onClick={handleInterrupt}
                className="flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-3 py-1 text-[12px] text-rose-300 transition-colors hover:bg-rose-500/20"
              >
                <Square className="h-3 w-3" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || status === 'exited'}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1 text-[12px] text-neutral-500 transition-colors hover:bg-[#1a1a1a] hover:text-neutral-300 disabled:opacity-30"
              >
                <span>Send</span>
                <CornerDownLeft className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Live "Working" block shown during processing ---

function LiveWorkingBlock({
  tools,
  textBlocks,
  isProcessing,
  streamingText,
  thinkingText,
  toolProgress,
}: {
  tools: ContentBlock[];
  textBlocks: ContentBlock[];
  isProcessing: boolean;
  streamingText: string;
  thinkingText: string;
  toolProgress: { toolName: string; elapsedSeconds: number } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toolCount = tools.length;
  const hasStreamingText = streamingText.length > 0;
  const hasThinking = thinkingText.length > 0;

  return (
    <div className="space-y-3">
      {/* Thinking block — collapsible */}
      {hasThinking && (
        <div>
          <button
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
            className="flex items-center gap-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-400"
          >
            {thinkingExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <BrainIcon className="h-3.5 w-3.5 text-violet-400" />
            <span className="text-violet-400/80">
              {isProcessing && !hasStreamingText ? 'Thinking...' : 'Thought process'}
            </span>
            {isProcessing && !hasStreamingText && (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
            )}
          </button>
          {thinkingExpanded && (
            <div className="ml-5 mt-1.5 max-h-48 overflow-y-auto rounded border border-violet-500/10 bg-violet-950/5 px-3 py-2">
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-500">{thinkingText}</p>
            </div>
          )}
        </div>
      )}

      {/* Tool actions header — only show when there are tools */}
      {(toolCount > 0 || (isProcessing && !hasStreamingText && !hasThinking)) && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-400"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {isProcessing && !hasStreamingText && !hasThinking && <Loader className="h-3 w-3 animate-spin text-blue-300" />}
            {isProcessing && hasStreamingText && toolCount > 0 && <Loader className="h-3 w-3 animate-spin text-blue-300" />}
            <span>
              {isProcessing
                ? (toolCount > 0 ? `Working (${toolCount} ${toolCount === 1 ? 'action' : 'actions'})` : 'Processing...')
                : `Processed (${toolCount} ${toolCount === 1 ? 'action' : 'actions'})`
              }
            </span>
          </button>

          {expanded && toolCount > 0 && (
            <div className="ml-5 mt-1.5 space-y-1.5 border-l border-[#1e1e1e] pl-3">
              {tools.map((tool, i) => (
                <ToolLine
                  key={i}
                  name={tool.name ?? 'Unknown'}
                  input={tool.input}
                  isLive={isProcessing}
                  isLast={i === toolCount - 1}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tool progress indicator ��� real-time elapsed time during long tool runs */}
      {toolProgress && isProcessing && (
        <div className="flex items-center gap-2 text-[12px] text-neutral-600">
          <Loader className="h-3 w-3 animate-spin text-blue-300" />
          <span>{toolProgress.toolName}</span>
          <span className="tabular-nums text-neutral-700">{Math.round(toolProgress.elapsedSeconds)}s</span>
        </div>
      )}

      {/* Real-time streaming text with blinking cursor */}
      {hasStreamingText && (
        <div className="prose prose-invert max-w-none">
          <TextBlock text={streamingText} />
          {isProcessing && (
            <span className="inline-block h-4 w-0.5 animate-pulse bg-blue-400 align-text-bottom ml-0.5" />
          )}
        </div>
      )}

      {/* Completed text blocks (fallback if no streaming deltas) */}
      {!hasStreamingText && textBlocks.map((block, i) => (
        <TextBlock key={`st-${i}`} text={block.text ?? ''} />
      ))}
    </div>
  );
}

// --- Message bubble ---

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const hasOnlyToolResult = message.content.every(b => b.type === 'tool_result');
  if (hasOnlyToolResult) return null;

  if (isUser) {
    const text = message.content.find(b => b.type === 'text')?.text ?? '';
    const attachments = message.contextAttachments;
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] space-y-1.5 rounded-2xl rounded-br-sm bg-[#2a2a2a] px-4 py-2.5">
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {attachments.map((att, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded border border-[#3a3a3a] bg-[#222] px-1.5 py-0.5 text-[11px] text-neutral-400">
                  {att.type === 'file' && <FileText className="h-2.5 w-2.5" />}
                  {att.type === 'branch' && <GitBranchIcon className="h-2.5 w-2.5" />}
                  {att.type === 'commit' && <GitCommit className="h-2.5 w-2.5" />}
                  {att.type === 'changes' && <FileDiff className="h-2.5 w-2.5" />}
                  {att.label}
                </span>
              ))}
            </div>
          )}
          <p className="text-[14px] leading-relaxed text-neutral-200">{text}</p>
        </div>
      </div>
    );
  }

  const groups = groupContentBlocks(message.content);

  return (
    <div className="space-y-3">
      {groups.map((group, i) => {
        if (group.type === 'text') return <TextBlock key={i} text={group.text} />;
        if (group.type === 'thinking') return <ThinkingBlock key={i} thinking={group.thinking} />;
        if (group.type === 'tool_group') return <ProcessedGroup key={i} tools={group.tools} />;
        return null;
      })}
    </div>
  );
}

// --- Group consecutive tool blocks ---

interface TextGroup { type: 'text'; text: string }
interface ThinkingGroup { type: 'thinking'; thinking: string }
interface ToolEntry {
  name: string;
  input: unknown;
  toolUseId?: string;
  result?: { content?: string; stdout?: string; stderr?: string; is_error?: boolean; structuredPatch?: ContentBlock['structuredPatch'] };
}
interface ToolGroup { type: 'tool_group'; tools: ToolEntry[] }
type BlockGroup = TextGroup | ThinkingGroup | ToolGroup;

function groupContentBlocks(blocks: ContentBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let currentTools: ToolEntry[] = [];

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      currentTools.push({
        name: block.name ?? 'Unknown',
        input: block.input,
        toolUseId: block.tool_use_id,
      });
    } else if (block.type === 'tool_result') {
      // Attach result to matching tool_use
      const matching = currentTools.find(t => t.toolUseId === block.tool_use_id);
      if (matching) {
        matching.result = {
          content: block.content,
          stdout: block.stdout,
          stderr: block.stderr,
          is_error: block.is_error,
          structuredPatch: block.structuredPatch,
        };
      }
    } else if (block.type === 'thinking' && block.thinking) {
      if (currentTools.length > 0) {
        groups.push({ type: 'tool_group', tools: [...currentTools] });
        currentTools = [];
      }
      groups.push({ type: 'thinking', thinking: block.thinking });
    } else if (block.type === 'text' && block.text) {
      if (currentTools.length > 0) {
        groups.push({ type: 'tool_group', tools: [...currentTools] });
        currentTools = [];
      }
      groups.push({ type: 'text', text: block.text });
    }
  }
  if (currentTools.length > 0) {
    groups.push({ type: 'tool_group', tools: currentTools });
  }
  return groups;
}

// --- Thinking block (collapsed by default in completed messages) ---

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = thinking.slice(0, 80).replace(/\n/g, ' ');

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-400"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <BrainIcon className="h-3.5 w-3.5 text-violet-400/60" />
        <span className="text-violet-400/50">Thought process</span>
        {!expanded && <span className="max-w-[300px] truncate text-[11px] text-neutral-700">{preview}...</span>}
      </button>
      {expanded && (
        <div className="ml-5 mt-1.5 max-h-64 overflow-y-auto rounded border border-violet-500/10 bg-violet-950/5 px-3 py-2">
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-500">{thinking}</p>
        </div>
      )}
    </div>
  );
}

// --- Processed group (collapsed by default) ---

function ProcessedGroup({ tools }: { tools: ToolEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasErrors = tools.some(t => t.result?.is_error);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-400"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {hasErrors
          ? <AlertTriangleIcon className="h-3 w-3 text-amber-300/70" />
          : <Check className="h-3 w-3 text-emerald-300" />
        }
        <span>Processed ({tools.length} {tools.length === 1 ? 'action' : 'actions'})</span>
      </button>
      {expanded && (
        <div className="ml-5 mt-1.5 space-y-1.5 border-l border-[#1e1e1e] pl-3">
          {tools.map((tool, i) => (
            <ToolLine
              key={i}
              name={tool.name}
              input={tool.input}
              result={tool.result}
              isLive={false}
              isLast={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Tool summary with icons ---

interface ToolInfo {
  icon: LucideIcon;
  label: string;
  animate?: boolean;
}

function getToolInfo(name: string, input: unknown, isLive: boolean): ToolInfo {
  const inp = input as Record<string, unknown> | null;
  switch (name) {
    case 'Read': return { icon: BookOpen, label: `Reading ${inp?.file_path ?? 'file'}`, animate: isLive };
    case 'Edit': return { icon: Pencil, label: `Editing ${inp?.file_path ?? 'file'}`, animate: isLive };
    case 'Write': return { icon: FilePlus, label: `Writing ${inp?.file_path ?? 'file'}`, animate: isLive };
    case 'Bash': return { icon: Terminal, label: `Running ${typeof inp?.command === 'string' ? inp.command.slice(0, 60) : 'command'}`, animate: isLive };
    case 'Glob': return { icon: FolderSearch, label: `Searching ${inp?.pattern ?? 'files'}`, animate: isLive };
    case 'Grep': return { icon: Search, label: `Searching for ${inp?.pattern ?? 'pattern'}`, animate: isLive };
    case 'TodoWrite': return { icon: ListChecks, label: 'Updating tasks', animate: isLive };
    case 'WebSearch': return { icon: Globe, label: `Searching web: ${inp?.query ?? ''}`, animate: isLive };
    case 'WebFetch': return { icon: Link, label: `Fetching ${inp?.url ?? 'URL'}`, animate: isLive };
    case 'Agent': return { icon: Bot, label: `Running agent: ${inp?.description ?? ''}`, animate: isLive };
    case 'Skill': return { icon: Zap, label: `Running /${inp?.skill ?? 'skill'}`, animate: isLive };
    default: return { icon: Zap, label: name, animate: isLive };
  }
}

function ToolLine({ name, input, result, isLive, isLast }: {
  name: string;
  input: unknown;
  result?: { content?: string; stdout?: string; stderr?: string; is_error?: boolean; structuredPatch?: ContentBlock['structuredPatch'] };
  isLive: boolean;
  isLast: boolean;
}) {
  const info = getToolInfo(name, input, isLive);
  const Icon = info.icon;
  const shouldAnimate = isLive && isLast;
  const context = getToolContext(name, input);
  const [showDetails, setShowDetails] = useState(false);
  const hasStructuredPatch = !isLive && result?.structuredPatch && result.structuredPatch.length > 0;
  const hasEditDiff = (name === 'Edit' && !isLive) || hasStructuredPatch;
  const hasResult = !isLive && result && (result.stdout || result.stderr || result.content);
  const isExpandable = hasEditDiff || hasResult;
  const inp = input as Record<string, unknown> | null;

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => isExpandable && setShowDetails(prev => !prev)}
        className={`flex items-center gap-2 text-[12px] text-neutral-600 ${isExpandable ? 'cursor-pointer hover:text-neutral-400' : ''}`}
      >
        <Icon className={`h-3 w-3 shrink-0 ${shouldAnimate ? 'animate-pulse text-blue-300' : result?.is_error ? 'text-rose-300' : 'text-neutral-600'}`} />
        <span className={shouldAnimate ? 'text-neutral-400' : ''}>{info.label}</span>
        {isExpandable && (
          showDetails
            ? <ChevronDown className="h-2.5 w-2.5 text-neutral-700" />
            : <ChevronRight className="h-2.5 w-2.5 text-neutral-700" />
        )}
      </button>
      {context && !showDetails && (
        <div className="ml-5 truncate text-[11px] font-mono text-neutral-700">
          {context}
        </div>
      )}
      {showDetails && (
        <div className="ml-5 mt-1 space-y-1">
          {/* Edit diff — prefer structured patch from tool result if available */}
          {hasEditDiff && inp && (
            <div className="overflow-x-auto rounded border border-[#1e1e1e] bg-[#0a0a0a] text-[11px]">
              {hasStructuredPatch ? (
                <StructuredPatchView filePath={inp.file_path as string} patches={result!.structuredPatch!} />
              ) : (
                <EditDiffView
                  filePath={inp.file_path as string}
                  oldString={inp.old_string as string | undefined}
                  newString={inp.new_string as string | undefined}
                />
              )}
            </div>
          )}
          {/* Tool stdout */}
          {result?.stdout && (
            <pre className="max-h-40 overflow-auto rounded border border-[#1e1e1e] bg-[#0a0a0a] px-2 py-1.5 text-[11px] font-mono text-neutral-500">
              {result.stdout.slice(0, 3000)}
              {result.stdout.length > 3000 && '\n... (truncated)'}
            </pre>
          )}
          {/* Tool stderr */}
          {result?.stderr && (
            <pre className="max-h-24 overflow-auto rounded border border-red-900/20 bg-red-950/10 px-2 py-1.5 text-[11px] font-mono text-rose-300/70">
              {result.stderr.slice(0, 1000)}
            </pre>
          )}
          {/* Tool result content (fallback) */}
          {!result?.stdout && !result?.stderr && result?.content && (
            <pre className="max-h-40 overflow-auto rounded border border-[#1e1e1e] bg-[#0a0a0a] px-2 py-1.5 text-[11px] font-mono text-neutral-500">
              {result.content.slice(0, 3000)}
              {result.content.length > 3000 && '\n... (truncated)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Compute simple LCS-based diff between two line arrays */
function computeLineDiff(oldLines: string[], newLines: string[]): Array<{ type: 'same' | 'removed' | 'added'; line: string; oldNum?: number; newNum?: number }> {
  const result: Array<{ type: 'same' | 'removed' | 'added'; line: string; oldNum?: number; newNum?: number }> = [];

  // Simple O(n*m) LCS for reasonable sizes
  if (oldLines.length > 200 || newLines.length > 200) {
    // Fallback: show all old as removed, all new as added
    oldLines.forEach((l, i) => result.push({ type: 'removed', line: l, oldNum: i + 1 }));
    newLines.forEach((l, i) => result.push({ type: 'added', line: l, newNum: i + 1 }));
    return result;
  }

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const diff: Array<{ type: 'same' | 'removed' | 'added'; line: string; oi: number; ni: number }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'same', line: oldLines[i - 1], oi: i, ni: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'added', line: newLines[j - 1], oi: 0, ni: j });
      j--;
    } else {
      diff.unshift({ type: 'removed', line: oldLines[i - 1], oi: i, ni: 0 });
      i--;
    }
  }

  return diff.map(d => ({
    type: d.type,
    line: d.line,
    oldNum: d.type !== 'added' ? d.oi : undefined,
    newNum: d.type !== 'removed' ? d.ni : undefined,
  }));
}

function PermissionPrompt({
  permission,
  onApproveSession,
  onApproveProject,
  onReject,
}: {
  permission: { toolName: string; toolInput: unknown; toolUseId: string };
  onApproveSession: () => void;
  onApproveProject: () => void;
  onReject: () => void;
}) {
  const inp = permission.toolInput as Record<string, unknown> | null;
  const filePath = inp?.file_path as string | undefined;
  const fileName = filePath ? filePath.split('/').pop() : undefined;
  const isEdit = permission.toolName === 'Edit';
  const isWrite = permission.toolName === 'Write';
  const isBash = permission.toolName === 'Bash';
  const isFileOp = isEdit || isWrite;
  const toolLabel = isEdit ? 'Edit file' : isWrite ? 'Write file' : isBash ? 'Run command' : permission.toolName;

  return (
    <div className="shrink-0 px-6 py-3">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-blue-500/30 bg-[#141418]">
        {/* Header */}
        <div className="px-5 pt-4 pb-2">
          <p className={`text-[13px] font-semibold ${isFileOp ? 'text-emerald-300' : isBash ? 'text-amber-300' : 'text-blue-300'}`}>
            {toolLabel}
          </p>
          {fileName && (
            <p className="mt-0.5 text-[12px] text-neutral-500">{fileName}</p>
          )}
        </div>

        {/* Preview */}
        {isEdit && filePath != null && (
          <div className="mx-5 mb-3 overflow-hidden rounded border border-[#1e1e1e] bg-[#0a0a0a]">
            <EditDiffView
              filePath={filePath}
              oldString={inp?.old_string as string | undefined}
              newString={inp?.new_string as string | undefined}
            />
          </div>
        )}
        {isWrite && filePath != null && (
          <div className="mx-5 mb-3 overflow-hidden rounded border border-[#1e1e1e] bg-[#0a0a0a]">
            <EditDiffView
              filePath={filePath}
              newString={typeof inp?.content === 'string' ? inp.content.slice(0, 2000) : undefined}
            />
          </div>
        )}
        {isBash && typeof inp?.command === 'string' && (
          <pre className="mx-5 mb-3 max-h-32 overflow-auto rounded border border-[#1e1e1e] bg-[#0a0a0a] px-3 py-2 text-[12px] font-mono text-neutral-400">
            $ {inp.command}
          </pre>
        )}
        {!isFileOp && !isBash && inp != null && (
          <pre className="mx-5 mb-3 max-h-24 overflow-auto text-[11px] text-neutral-500">
            {filePath ?? (inp.pattern ? String(inp.pattern) : JSON.stringify(inp, null, 2).slice(0, 200))}
          </pre>
        )}

        {/* Question */}
        <p className="px-5 pb-3 text-[13px] text-neutral-300">
          {isFileOp
            ? `Do you want to make this edit to ${fileName ?? 'this file'}?`
            : isBash
              ? 'Do you want to run this command?'
              : `Allow ${permission.toolName}?`}
        </p>

        {/* Options as numbered list */}
        <div className="flex flex-col gap-1 px-5 pb-4">
          <button
            onClick={onApproveSession}
            className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[#1a1a1e]"
          >
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-blue-500/70 text-[11px] font-semibold text-white">1</div>
            <span className="text-[13px] font-medium text-neutral-300">Yes</span>
          </button>
          <button
            onClick={onApproveProject}
            className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[#1a1a1e]"
          >
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-neutral-700/50 text-[11px] font-semibold text-neutral-400">2</div>
            <div className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-neutral-300">
                Yes, allow all {isFileOp ? 'edits' : isBash ? 'commands' : 'uses'} during this session
              </span>
            </div>
          </button>
          <button
            onClick={onReject}
            className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[#1a1a1e]"
          >
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-neutral-700/50 text-[11px] font-semibold text-neutral-400">3</div>
            <div className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-neutral-300">No, and tell Claude what to do differently</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function EditDiffView({ filePath, oldString, newString }: { filePath: string; oldString?: string; newString?: string }) {
  const shortPath = shortenPath(filePath ?? '');

  if (!oldString && !newString) {
    return <p className="px-3 py-2 text-neutral-600">No changes</p>;
  }

  // For Write tool (no old_string), show as all additions
  if (!oldString && newString) {
    const lines = newString.split('\n');
    return (
      <div>
        <div className="flex items-center gap-2 border-b border-[#1e1e1e] bg-[#111] px-3 py-1.5">
          <FilePlus className="h-3 w-3 text-emerald-300" />
          <span className="text-[11px] font-mono text-neutral-400">{shortPath}</span>
          <span className="text-[10px] text-emerald-300/70">+{lines.length} lines</span>
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full border-collapse font-mono text-[11px] leading-[18px]">
            <tbody>
              {lines.slice(0, 50).map((line, i) => (
                <tr key={i} className="bg-emerald-950/10">
                  <td className="w-10 select-none border-r border-[#1e1e1e] px-2 text-right text-neutral-700">{i + 1}</td>
                  <td className="w-5 select-none px-1 text-center text-emerald-400/70">+</td>
                  <td className="whitespace-pre-wrap break-all px-2 text-emerald-300/90">{line || ' '}</td>
                </tr>
              ))}
              {lines.length > 50 && (
                <tr><td colSpan={3} className="px-3 py-1 text-neutral-600">...+{lines.length - 50} more lines</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Edit: compute proper unified diff
  const oldLines = (oldString ?? '').split('\n');
  const newLines = (newString ?? '').split('\n');
  const diff = computeLineDiff(oldLines, newLines);
  const removedCount = diff.filter(d => d.type === 'removed').length;
  const addedCount = diff.filter(d => d.type === 'added').length;

  return (
    <div>
      {/* File header */}
      <div className="flex items-center gap-2 border-b border-[#1e1e1e] bg-[#111] px-3 py-1.5">
        <Pencil className="h-3 w-3 text-blue-300" />
        <span className="text-[11px] font-mono text-neutral-400">{shortPath}</span>
        <div className="ml-auto flex items-center gap-2 text-[10px]">
          {removedCount > 0 && <span className="text-rose-300/70">-{removedCount}</span>}
          {addedCount > 0 && <span className="text-emerald-300/70">+{addedCount}</span>}
        </div>
      </div>
      {/* Diff lines */}
      <div className="max-h-64 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px] leading-[18px]">
          <tbody>
            {diff.slice(0, 80).map((d, i) => {
              const bgClass = d.type === 'removed' ? 'bg-rose-950/10'
                : d.type === 'added' ? 'bg-emerald-950/10'
                : '';
              const numColor = d.type === 'same' ? 'text-neutral-700' : 'text-neutral-600';
              const signColor = d.type === 'removed' ? 'text-rose-300/70' : d.type === 'added' ? 'text-emerald-400/70' : 'text-neutral-800';
              const textColor = d.type === 'removed' ? 'text-rose-300/80'
                : d.type === 'added' ? 'text-emerald-300/90'
                : 'text-neutral-500';
              const sign = d.type === 'removed' ? '-' : d.type === 'added' ? '+' : ' ';

              return (
                <tr key={i} className={bgClass}>
                  <td className={`w-8 select-none border-r border-[#1a1a1a] px-1.5 text-right ${numColor}`}>
                    {d.oldNum ?? ''}
                  </td>
                  <td className={`w-8 select-none border-r border-[#1a1a1a] px-1.5 text-right ${numColor}`}>
                    {d.newNum ?? ''}
                  </td>
                  <td className={`w-4 select-none px-0.5 text-center ${signColor}`}>{sign}</td>
                  <td className={`whitespace-pre-wrap break-all px-2 ${textColor}`}>{d.line || ' '}</td>
                </tr>
              );
            })}
            {diff.length > 80 && (
              <tr><td colSpan={4} className="px-3 py-1 text-neutral-600">...{diff.length - 80} more lines</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Render a structured patch from the SDK's tool_use_result — proper hunk-based diff */
function StructuredPatchView({ filePath, patches }: { filePath: string; patches: NonNullable<ContentBlock['structuredPatch']> }) {
  const shortPath = shortenPath(filePath ?? '');
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const hunk of patches) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) totalAdded++;
      else if (line.startsWith('-')) totalRemoved++;
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[#1e1e1e] bg-[#111] px-3 py-1.5">
        <Pencil className="h-3 w-3 text-blue-300" />
        <span className="text-[11px] font-mono text-neutral-400">{shortPath}</span>
        <div className="ml-auto flex items-center gap-2 text-[10px]">
          {totalRemoved > 0 && <span className="text-rose-300/70">-{totalRemoved}</span>}
          {totalAdded > 0 && <span className="text-emerald-300/70">+{totalAdded}</span>}
        </div>
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px] leading-[18px]">
          <tbody>
            {patches.map((hunk, hi) => {
              let oldLine = hunk.oldStart;
              let newLine = hunk.newStart;
              return (
                <React.Fragment key={hi}>
                  {hi > 0 && (
                    <tr><td colSpan={4} className="border-y border-[#1a1a1a] bg-[#0d0d0d] px-3 py-0.5 text-[10px] text-neutral-700">...</td></tr>
                  )}
                  {hunk.lines.slice(0, 100).map((line, li) => {
                    const isRemoved = line.startsWith('-');
                    const isAdded = line.startsWith('+');
                    const isContext = !isRemoved && !isAdded;
                    const bgClass = isRemoved ? 'bg-rose-950/10' : isAdded ? 'bg-emerald-950/10' : '';
                    const numColor = isContext ? 'text-neutral-700' : 'text-neutral-600';
                    const signColor = isRemoved ? 'text-rose-300/70' : isAdded ? 'text-emerald-400/70' : 'text-neutral-800';
                    const textColor = isRemoved ? 'text-rose-300/80' : isAdded ? 'text-emerald-300/90' : 'text-neutral-500';
                    const sign = isRemoved ? '-' : isAdded ? '+' : ' ';
                    const oNum = isAdded ? '' : oldLine;
                    const nNum = isRemoved ? '' : newLine;
                    if (!isAdded) oldLine++;
                    if (!isRemoved) newLine++;
                    return (
                      <tr key={`${hi}-${li}`} className={bgClass}>
                        <td className={`w-8 select-none border-r border-[#1a1a1a] px-1.5 text-right ${numColor}`}>{oNum}</td>
                        <td className={`w-8 select-none border-r border-[#1a1a1a] px-1.5 text-right ${numColor}`}>{nNum}</td>
                        <td className={`w-4 select-none px-0.5 text-center ${signColor}`}>{sign}</td>
                        <td className={`whitespace-pre-wrap break-all px-2 ${textColor}`}>{line.slice(1) || ' '}</td>
                      </tr>
                    );
                  })}
                  {hunk.lines.length > 100 && (
                    <tr><td colSpan={4} className="px-3 py-1 text-neutral-600">...{hunk.lines.length - 100} more lines</td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Extract a short context preview for tool actions */
function getToolContext(name: string, input: unknown): string | null {
  const inp = input as Record<string, unknown> | null;
  if (!inp) return null;

  switch (name) {
    case 'Read': {
      const fp = inp.file_path as string | undefined;
      if (!fp) return null;
      const parts: string[] = [];
      if (inp.offset) parts.push(`L${inp.offset}`);
      if (inp.limit) parts.push(`${inp.limit} lines`);
      return parts.length > 0 ? `${shortenPath(fp)} (${parts.join(', ')})` : shortenPath(fp);
    }
    case 'Edit': {
      const fp = inp.file_path as string | undefined;
      if (!fp) return null;
      const old = inp.old_string as string | undefined;
      if (old) {
        const firstLine = old.split('\n')[0].trim().slice(0, 60);
        return `${shortenPath(fp)} — "${firstLine}"`;
      }
      return shortenPath(fp);
    }
    case 'Write':
      return inp.file_path ? shortenPath(inp.file_path as string) : null;
    case 'Bash': {
      const cmd = inp.command as string | undefined;
      if (!cmd || cmd.length <= 60) return null;
      return cmd.slice(0, 100) + (cmd.length > 100 ? '...' : '');
    }
    case 'Grep': {
      const parts: string[] = [];
      if (inp.pattern) parts.push(`/${inp.pattern}/`);
      if (inp.path) parts.push(`in ${shortenPath(inp.path as string)}`);
      else if (inp.glob) parts.push(`in ${inp.glob}`);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'Glob': {
      const parts: string[] = [];
      if (inp.pattern) parts.push(inp.pattern as string);
      if (inp.path) parts.push(`in ${shortenPath(inp.path as string)}`);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'Agent':
      return inp.prompt ? (inp.prompt as string).slice(0, 80) + '...' : null;
    default:
      return null;
  }
}

/** Shorten a file path to last 2-3 segments */
function shortenPath(fp: string): string {
  const parts = fp.split('/');
  return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : fp;
}

// --- Options constants ---

const MODEL_OPTIONS = [
  { id: 'opus', label: 'Opus 4.6' },
  { id: 'sonnet', label: 'Sonnet 4.6' },
  { id: 'haiku', label: 'Haiku 4.5' },
] as const;

const PERMISSION_OPTIONS = [
  { id: 'plan', label: 'Plan', description: 'Create plan before making changes', badgeBg: 'bg-amber-900/40', badgeText: 'text-amber-300/90' },
  { id: 'ask', label: 'Ask Permission', description: 'Prompt for permission on the first use of each tool', badgeBg: 'bg-sky-900/40', badgeText: 'text-sky-300/90' },
  { id: 'auto-edit', label: 'Auto-Edit', description: 'Auto-accept file edit permissions', badgeBg: 'bg-orange-900/40', badgeText: 'text-orange-300/80/90' },
  { id: 'full-access', label: 'Full Access', description: 'Skip all permission prompts', badgeBg: 'bg-rose-900/40', badgeText: 'text-rose-300/90' },
] as const;

const EFFORT_OPTIONS = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
] as const;

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

const CONTEXT_MENU_ITEMS = [
  { id: 'files', label: 'Files and Folders', icon: FileText },
  { id: 'branches', label: 'Git Branches', icon: GitBranchIcon },
  { id: 'commits', label: 'Git Commits', icon: GitCommit },
  { id: 'changes', label: 'Local Changes', icon: FileDiff },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'upload', label: 'Upload from Computer...', icon: Upload },
] as const;

// --- Dropdown menu ---

interface DropdownItem {
  id: string;
  label: string;
  sublabel?: string;
  active: boolean;
  color?: string;
  icon?: React.ReactNode;
}

function DropdownMenu({
  items,
  onSelect,
  onClose,
  title,
}: {
  items: DropdownItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 z-30 mb-1 min-w-[200px] overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#141414] shadow-xl"
    >
      {title && (
        <div className="px-3 py-2 text-[11px] font-medium text-neutral-600">{title}</div>
      )}
      <div className="py-1">
        {items.map(item => (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
              item.active ? 'bg-[#1e1e1e]' : 'hover:bg-[#1a1a1a]'
            }`}
          >
            {item.icon && <span className="shrink-0 text-neutral-500">{item.icon}</span>}
            <span className={`text-[13px] font-medium ${item.color ?? 'text-neutral-300'}`}>
              {item.label}
            </span>
            {item.sublabel && (
              <span className="ml-auto text-[11px] text-neutral-600">{item.sublabel}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- User question form (AskUserQuestion) ---

interface QuestionDef {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  allowMultiple?: boolean;
}

function UserQuestionForm({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: QuestionDef[];
  onSubmit: (answers: string[]) => void;
  onSkip: () => void;
}) {
  const [selections, setSelections] = useState<Record<number, Set<string>>>({});

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelections(prev => {
      const current = prev[qIdx] ?? new Set<string>();
      const next = new Set(current);
      if (multi) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        if (next.has(label)) next.clear();
        else { next.clear(); next.add(label); }
      }
      return { ...prev, [qIdx]: next };
    });
  };

  const handleSubmit = () => {
    const answers: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const sel = selections[i];
      if (sel && sel.size > 0) {
        answers.push(...sel);
      }
    }
    if (answers.length > 0) onSubmit(answers);
  };

  const hasSelection = Object.values(selections).some(s => s.size > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-blue-500/30 bg-[#141418]">
      {questions.map((q, qIdx) => {
        const multi = q.allowMultiple ?? false;
        const selected = selections[qIdx] ?? new Set<string>();

        return (
          <div key={qIdx} className="px-5 py-4">
            {q.header && (
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-600">{q.header}</p>
            )}
            <p className="mb-3 text-[14px] font-medium text-neutral-200">{q.question}</p>

            {q.options && q.options.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {q.options.map((opt, oIdx) => {
                  const isSelected = selected.has(opt.label);
                  return (
                    <button
                      key={oIdx}
                      onClick={() => toggle(qIdx, opt.label, multi)}
                      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        isSelected ? 'bg-blue-500/15' : 'hover:bg-[#1a1a1e]'
                      }`}
                    >
                      {/* Checkbox / Numbered indicator */}
                      {multi ? (
                        <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                          isSelected
                            ? 'border-blue-500 bg-blue-500/70 text-white'
                            : 'border-neutral-600 bg-transparent'
                        }`}>
                          {isSelected && <Check className="h-3 w-3" />}
                        </div>
                      ) : (
                        <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${
                          isSelected
                            ? 'bg-blue-500/70 text-white'
                            : 'bg-neutral-700/50 text-neutral-400'
                        }`}>
                          {oIdx + 1}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <span className={`block text-[13px] font-medium ${isSelected ? 'text-neutral-200' : 'text-neutral-300'}`}>
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="block text-[12px] text-neutral-600">{opt.description}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              /* Free-text input if no options */
              <input
                type="text"
                placeholder="Type your answer..."
                className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[13px] text-neutral-300 placeholder-neutral-600 outline-none"
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) onSubmit([val]);
                  }
                }}
              />
            )}
          </div>
        );
      })}

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-[#1e1e1e] px-5 py-3">
        {hasSelection ? (
          <button
            onClick={handleSubmit}
            className="flex items-center gap-2 rounded-lg bg-blue-500/70 px-4 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-blue-500"
          >
            Submit
            <kbd className="flex items-center gap-0.5 rounded bg-blue-400/30 px-1.5 py-0.5 text-[10px] font-medium text-blue-200">&#x2318;&#x21B5;</kbd>
          </button>
        ) : (
          <button
            onClick={onSkip}
            className="flex items-center gap-2 rounded-lg bg-neutral-700/50 px-4 py-1.5 text-[12px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700"
          >
            Skip
            <kbd className="flex items-center gap-0.5 rounded bg-neutral-600/40 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">&#x238C;</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

// --- Permission mode dropdown (badge style) ---

function PermissionDropdown({
  selectedId,
  onSelect,
  onClose,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 z-30 mb-1 min-w-[260px] overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#141414] shadow-xl"
    >
      <div className="px-3 py-2 text-[11px] font-medium text-neutral-600">Permission Mode</div>
      <div className="py-1">
        {PERMISSION_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => onSelect(opt.id)}
            className={`flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors ${
              opt.id === selectedId ? 'bg-blue-500/15' : 'hover:bg-[#1a1a1a]'
            }`}
          >
            <span className={`self-start rounded px-1.5 py-0.5 text-[12px] font-semibold ${opt.badgeBg} ${opt.badgeText}`}>
              {opt.label}
            </span>
            <span className="text-[12px] text-neutral-500">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Context menu (+ button) ---

function ContextMenuDropdown({ onClose, onOpenPanel }: { onClose: () => void; onOpenPanel: (panel: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const handleItem = (id: string) => {
    const panelItems = ['files', 'branches', 'commits', 'changes', 'mcp'];
    if (panelItems.includes(id)) {
      onOpenPanel(id);
    } else if (id === 'upload') {
      onOpenPanel('upload');
    } else {
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className="min-w-[220px] overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#141414] shadow-xl"
    >
      <div className="py-1">
        {CONTEXT_MENU_ITEMS.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => handleItem(item.id)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[#1a1a1a]"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
              <span className="text-[13px] text-neutral-400">{item.label}</span>
              {['files', 'branches', 'commits', 'changes', 'mcp'].includes(item.id) && (
                <ChevronRight className="ml-auto h-3 w-3 text-neutral-700" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Context sub-panels ---

interface ContextSubPanelProps {
  panel: string;
  instanceId: string;
  sessionInfo?: SessionInfo | null;
  onAttach: (item: ContextItem) => void;
  onClose: () => void;
}

function ContextSubPanel({ panel, instanceId, sessionInfo, onAttach, onClose }: ContextSubPanelProps) {
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<unknown>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  useEffect(() => {
    // MCP doesn't need async fetch from context API
    if (panel === 'mcp') { setLoading(false); return; }

    const endpoint = `/api/instances/${instanceId}/context/${panel}`;
    fetch(endpoint)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [instanceId, panel]);

  const handleAttachFile = async (filePath: string) => {
    try {
      const res = await fetch(`/api/instances/${instanceId}/context/file-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const result = await res.json() as { path: string; content: string };
      onAttach({ type: 'file', label: filePath, value: result.content });
    } catch {
      onAttach({ type: 'file', label: filePath, value: `(failed to read ${filePath})` });
    }
  };

  const title = panel === 'files' ? 'Files and Folders'
    : panel === 'branches' ? 'Git Branches'
    : panel === 'commits' ? 'Git Commits'
    : panel === 'changes' ? 'Local Changes'
    : panel === 'mcp' ? 'MCP Servers'
    : panel;

  const showFilter = !['changes', 'mcp'].includes(panel);

  return (
    <div
      ref={ref}
      className="max-h-[360px] overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#141414] shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[#1e1e1e] px-3 py-2">
        <button onClick={onClose} className="text-neutral-600 hover:text-neutral-400">
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <span className="text-[12px] font-medium text-neutral-400">{title}</span>
      </div>

      {/* Filter */}
      {showFilter && (
        <div className="border-b border-[#1e1e1e] px-3 py-2">
          <input
            type="text"
            placeholder={`Filter ${title.toLowerCase()}...`}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoFocus
            className="w-full bg-transparent text-[13px] text-neutral-300 placeholder-neutral-600 outline-none"
          />
        </div>
      )}

      {/* Content */}
      <div className="max-h-[260px] overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader className="h-4 w-4 animate-spin text-neutral-600" />
          </div>
        ) : panel === 'files' ? (
          <FilesList data={data} filter={filter} onSelect={handleAttachFile} />
        ) : panel === 'branches' ? (
          <BranchesList data={data} filter={filter} onSelect={(name: string) => {
            onAttach({ type: 'branch', label: name, value: name });
          }} />
        ) : panel === 'commits' ? (
          <CommitsList data={data} filter={filter} onSelect={(hash: string, subject: string) => {
            onAttach({ type: 'commit', label: `${hash} ${subject}`, value: `Commit ${hash}: ${subject}` });
          }} />
        ) : panel === 'changes' ? (
          <ChangesList data={data} onAttach={() => {
            const d = data as { files: { status: string; path: string }[]; diffSummary: string } | null;
            if (d) {
              const summary = d.files.map(f => `${f.status} ${f.path}`).join('\n');
              onAttach({ type: 'changes', label: `${d.files.length} changed files`, value: summary + '\n\n' + d.diffSummary });
            }
          }} />
        ) : panel === 'mcp' ? (
          <McpServersList sessionInfo={sessionInfo} />
        ) : null}
      </div>
    </div>
  );
}

// Sub-panel list components

function FilesList({ data, filter, onSelect }: { data: unknown; filter: string; onSelect: (path: string) => void }) {
  const d = data as { files: string[] } | null;
  if (!d?.files) return <p className="py-4 text-center text-[12px] text-neutral-600">No files found</p>;
  const filtered = filter ? d.files.filter(f => f.toLowerCase().includes(filter.toLowerCase())) : d.files;
  if (filtered.length === 0) return <p className="py-4 text-center text-[12px] text-neutral-600">No matches</p>;
  return (
    <>
      {filtered.slice(0, 100).map(file => (
        <button
          key={file}
          onClick={() => onSelect(file)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#1a1a1a]"
        >
          <FileText className="h-3 w-3 shrink-0 text-neutral-600" />
          <span className="truncate text-[12px] text-neutral-400">{file}</span>
        </button>
      ))}
      {filtered.length > 100 && (
        <p className="px-3 py-1.5 text-[11px] text-neutral-600">...and {filtered.length - 100} more</p>
      )}
    </>
  );
}

function BranchesList({ data, filter, onSelect }: { data: unknown; filter: string; onSelect: (name: string) => void }) {
  const d = data as { branches: { name: string; date: string; subject: string }[] } | null;
  if (!d?.branches) return <p className="py-4 text-center text-[12px] text-neutral-600">No branches found</p>;
  const filtered = filter ? d.branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase())) : d.branches;
  if (filtered.length === 0) return <p className="py-4 text-center text-[12px] text-neutral-600">No matches</p>;
  return (
    <>
      {filtered.map(branch => (
        <button
          key={branch.name}
          onClick={() => onSelect(branch.name)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#1a1a1a]"
        >
          <GitBranchIcon className="h-3 w-3 shrink-0 text-neutral-600" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-400">{branch.name}</span>
          <span className="shrink-0 text-[11px] text-neutral-700">{branch.date}</span>
        </button>
      ))}
    </>
  );
}

function CommitsList({ data, filter, onSelect }: { data: unknown; filter: string; onSelect: (hash: string, subject: string) => void }) {
  const d = data as { commits: { hash: string; subject: string; date: string; author: string }[] } | null;
  if (!d?.commits) return <p className="py-4 text-center text-[12px] text-neutral-600">No commits found</p>;
  const filtered = filter ? d.commits.filter(c =>
    c.subject.toLowerCase().includes(filter.toLowerCase()) || c.hash.includes(filter)
  ) : d.commits;
  if (filtered.length === 0) return <p className="py-4 text-center text-[12px] text-neutral-600">No matches</p>;
  return (
    <>
      {filtered.map(commit => (
        <button
          key={commit.hash}
          onClick={() => onSelect(commit.hash, commit.subject)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#1a1a1a]"
        >
          <GitCommit className="h-3 w-3 shrink-0 text-neutral-600" />
          <span className="shrink-0 text-[12px] font-mono text-neutral-500">{commit.hash}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-400">{commit.subject}</span>
          <span className="shrink-0 text-[11px] text-neutral-700">{commit.date}</span>
        </button>
      ))}
    </>
  );
}

function ChangesList({ data, onAttach }: { data: unknown; onAttach: () => void }) {
  const d = data as { files: { status: string; path: string }[]; diffSummary: string } | null;
  if (!d?.files || d.files.length === 0) {
    return <p className="py-4 text-center text-[12px] text-neutral-600">No local changes</p>;
  }

  const statusColor = (s: string) => {
    if (s === 'M') return 'text-yellow-500';
    if (s === 'A' || s === '??' || s === '??') return 'text-emerald-300';
    if (s === 'D') return 'text-rose-300/70';
    return 'text-neutral-500';
  };

  return (
    <div>
      {d.files.map((file, i) => (
        <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
          <span className={`shrink-0 font-mono ${statusColor(file.status)}`}>{file.status}</span>
          <span className="truncate text-neutral-400">{file.path}</span>
        </div>
      ))}
      <div className="border-t border-[#1e1e1e] px-3 py-2">
        <button
          onClick={onAttach}
          className="w-full rounded-lg bg-blue-500/60 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-blue-500/80"
        >
          Attach all changes ({d.files.length} files)
        </button>
      </div>
    </div>
  );
}

// --- MCP Servers list ---

function McpServersList({ sessionInfo }: { sessionInfo?: SessionInfo | null }) {
  const servers = sessionInfo?.mcpServers ?? [];
  if (servers.length === 0) {
    return <p className="py-4 text-center text-[12px] text-neutral-600">No MCP servers connected</p>;
  }
  return (
    <>
      {servers.map((server, i) => (
        <div key={i} className="flex items-center gap-2 px-3 py-2 text-[12px]">
          <Server className="h-3 w-3 shrink-0 text-neutral-600" />
          <span className="flex-1 text-neutral-400">{server.name}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            server.status === 'connected'
              ? 'bg-green-900/30 text-emerald-300'
              : 'bg-red-900/30 text-rose-300'
          }`}>
            {server.status}
          </span>
        </div>
      ))}
    </>
  );
}

// --- Markdown text block ---

function TextBlock({ text }: { text: string }) {
  return (
    <div className="prose-custom text-[14px] leading-relaxed text-neutral-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const codeString = String(children).replace(/\n$/, '');
            if (match) return <CodeBlock language={match[1]} code={codeString} />;
            return <code className="rounded bg-[#1e1e1e] px-1.5 py-0.5 text-[13px] text-neutral-400" {...props}>{children}</code>;
          },
          pre({ children }) { return <>{children}</>; },
          p({ children }) { return <p className="mb-3 last:mb-0">{children}</p>; },
          ul({ children }) { return <ul className="mb-3 ml-4 list-disc space-y-1 text-neutral-300">{children}</ul>; },
          ol({ children }) { return <ol className="mb-3 ml-4 list-decimal space-y-1 text-neutral-300">{children}</ol>; },
          li({ children }) { return <li className="text-neutral-300">{children}</li>; },
          h1({ children }) { return <h1 className="mb-3 mt-5 text-[18px] font-semibold text-neutral-200">{children}</h1>; },
          h2({ children }) { return <h2 className="mb-2 mt-4 text-[16px] font-semibold text-neutral-200">{children}</h2>; },
          h3({ children }) { return <h3 className="mb-2 mt-3 text-[15px] font-semibold text-neutral-200">{children}</h3>; },
          a({ href, children }) { return <a href={href} className="text-blue-300 underline decoration-blue-400/30 hover:decoration-blue-400" target="_blank" rel="noopener noreferrer">{children}</a>; },
          blockquote({ children }) { return <blockquote className="mb-3 border-l-2 border-neutral-700 pl-3 text-neutral-400">{children}</blockquote>; },
          table({ children }) { return <div className="mb-3 overflow-x-auto"><table className="w-full border-collapse text-[13px]">{children}</table></div>; },
          th({ children }) { return <th className="border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-left text-neutral-300">{children}</th>; },
          td({ children }) { return <td className="border border-[#2a2a2a] px-3 py-1.5 text-neutral-400">{children}</td>; },
          hr() { return <hr className="my-4 border-[#1e1e1e]" />; },
          strong({ children }) { return <strong className="font-semibold text-neutral-200">{children}</strong>; },
          em({ children }) { return <em className="text-neutral-400">{children}</em>; },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// --- Code block with copy ---

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-[#1e1e1e]">
      <div className="flex items-center justify-between bg-[#1a1a1a] px-3 py-1.5">
        <span className="text-[11px] text-neutral-500">{language}</span>
        <button onClick={handleCopy} className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-neutral-400">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter style={oneDark} language={language} customStyle={{ margin: 0, padding: '12px', background: '#0a0a0a', fontSize: '13px', borderRadius: 0 }}>
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
