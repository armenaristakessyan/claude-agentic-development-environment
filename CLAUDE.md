# CLAUDE.md — Claude ADE (Agentic Development Environment)

## Project

Claude ADE is a local web dashboard for orchestrating multiple Claude Code instances in parallel. It uses the `@anthropic-ai/claude-agent-sdk` to manage persistent conversations with full Claude Code agent behavior (tools, CLAUDE.md, MCP, etc.). It exposes a chat-based interface in the browser with real-time streaming, thinking blocks, tool progress, context attachments, permission management, task history, a plugin marketplace, and RTK token compression integration.

## Stack

- **Monorepo** with npm workspaces: `packages/backend` + `packages/frontend`
- **Backend**: Node.js, TypeScript (ESM), Express, socket.io, `@anthropic-ai/claude-agent-sdk` (Agent SDK)
- **Frontend**: React 19 (Vite), TypeScript, Tailwind CSS 4, xterm.js, socket.io-client, lucide-react, react-markdown
- **Target**: macOS (requires `claude` CLI in PATH)

## Commands

- `npm run dev` — start backend + frontend in parallel (concurrently)
- `npm run dev:backend` — start backend only (tsx)
- `npm run dev:frontend` — start frontend only (vite)
- `npm run build` — production build for both packages
- `npm run lint` — ESLint across the monorepo
- `npm run typecheck` — TypeScript check without emit

## Structure

```
claude-dashboard/
├── CLAUDE.md
├── package.json                    # workspace root
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts              # Express + socket.io entry point, service wiring
│   │   │   ├── config.ts             # read/write config ~/.claude-dashboard/config.json
│   │   │   ├── scanner.ts            # ProjectScanner: project + worktree detection
│   │   │   ├── stream-process.ts     # StreamProcessManager: Agent SDK query(), canUseTool, streaming
│   │   │   ├── stream-socket.ts      # socket.io WebSocket handlers for chat events
│   │   │   ├── task-store.ts         # TaskStore: task + message persistence to disk
│   │   │   ├── worktree-manager.ts   # WorktreeManager: git worktree create/delete
│   │   │   ├── marketplace.ts        # MarketplaceService: plugin discovery, install/uninstall
│   │   │   ├── rtk-service.ts        # RtkService: RTK token compression integration
│   │   │   ├── routes.ts             # Express REST routes (all API endpoints)
│   │   │   ├── process-manager.ts    # (legacy) PTY-based process manager
│   │   │   ├── status-monitor.ts     # (legacy) PTY output parsing
│   │   │   └── socket.ts            # (legacy) PTY socket handlers
│   │   ├── package.json              # "type": "module", depends on @anthropic-ai/claude-agent-sdk
│   │   └── tsconfig.json
│   └── frontend/
│       ├── src/
│       │   ├── App.tsx               # Root: 3-column layout, topbar, hotkeys, RTK indicator
│       │   ├── main.tsx
│       │   ├── components/
│       │   │   ├── ChatView.tsx            # Chat: streaming, thinking blocks, tool progress, permissions
│       │   │   ├── TaskSidebar.tsx          # Left sidebar: task list + agent task tracking
│       │   │   ├── Sidebar.tsx             # Right sidebar: projects + changes + marketplace tabs
│       │   │   ├── ProjectList.tsx          # Hierarchical project browser with worktree management
│       │   │   ├── MarketplacePanel.tsx     # Plugin discovery and installation
│       │   │   ├── PluginDetailModal.tsx    # Plugin/skill detail viewer with scope contracts
│       │   │   ├── PluginCard.tsx           # Plugin card with install/uninstall
│       │   │   ├── TaskChangesPanel.tsx     # Git changes: diff, commit, push, PR, merge
│       │   │   ├── LaunchModal.tsx          # Task spawn modal with worktree option
│       │   │   ├── ScanPathsModal.tsx       # Modal to edit scan paths with folder browser
│       │   │   ├── AttentionQueueBanner.tsx # Banner for instances needing input
│       │   │   ├── ContextBanner.tsx        # Context/status banner
│       │   │   ├── RtkStatusIndicator.tsx   # RTK status + savings indicator in topbar
│       │   │   ├── InstanceList.tsx         # List of active instances
│       │   │   └── TerminalView.tsx         # xterm.js terminal embed (legacy)
│       │   ├── hooks/
│       │   │   ├── useSocket.ts            # Global singleton socket.io connection
│       │   │   ├── useInstances.ts         # Instance CRUD + socket events
│       │   │   ├── useProjects.ts          # Project list + worktree deletion
│       │   │   ├── useTaskHistory.ts       # Task persistence and resumption
│       │   │   ├── useMarketplace.ts       # Plugin discovery and installation
│       │   │   ├── useAttentionQueue.ts    # Queue of instances waiting for input
│       │   │   ├── useConfig.ts            # Read/update app config
│       │   │   ├── useHotkeys.ts           # Keyboard shortcuts
│       │   │   └── useRtk.ts              # RTK status, stats, install/uninstall
│       │   └── types.ts              # Shared frontend types
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts            # React + Tailwind + PWA + proxy to backend
└── README.md
```

## Architecture

### Message flow (Agent SDK)

1. Frontend sends message via POST `/api/instances/:id/messages` (or `chat:send` socket event)
2. `StreamProcessManager` pushes message into a live `query()` conversation via `InputController`
3. SDK streams messages: `system`, `assistant`, `user`, `stream_event`, `tool_progress`, `result`, `rate_limit_event`
4. Events are emitted to all sockets in the instance's room via socket.io
5. On `result` event, accumulated blocks are flushed as a single `ChatMessage`, deduplicated, and persisted
6. On session resume, messages are loaded from disk; the SDK resumes via `resume: sessionId`

### Agent SDK integration

The backend uses `@anthropic-ai/claude-agent-sdk` instead of spawning `claude --print`:

- **One persistent `query()` per instance** — conversations stay alive across turns
- **`canUseTool` callback** — fires live when Claude wants to use a tool; emits `permission_request` to frontend, waits for user response, returns allow/deny; Claude's turn continues seamlessly
- **`AskUserQuestion`** — handled inline via the same callback
- **`systemPrompt: { type: 'preset', preset: 'claude_code' }`** — full Claude Code agent with tools, CLAUDE.md, MCP
- **`settingSources: ['project', 'local']`** — loads project settings
- **`enableFileCheckpointing: true`** — enables `rewindFiles()` per message
- **`includePartialMessages: true`** — real-time streaming deltas (text + thinking)
- **`resume: sessionId`** — native session persistence
- **`conversation.interrupt()`** — clean interruption
- **`conversation.setModel()` / `setPermissionMode()`** — mid-session changes

### Instance lifecycle

- **Waiting input**: Instance created, ready for first prompt
- **Processing**: Claude is actively generating (streaming content blocks, using tools)
- **Waiting input**: Turn complete (`result` received), ready for next prompt
- **Exited**: Conversation closed or killed

### Content blocks

Messages contain typed content blocks streamed in real-time:
- `text` — markdown text with streaming deltas
- `thinking` — extended thinking content (collapsible in UI)
- `tool_use` — tool calls with name, input JSON
- `tool_result` — tool execution results (with stdout, stderr, structuredPatch)

### Agent task tracking

When Claude spawns sub-agents, the backend detects agent lifecycle events:
- `task_started` — new agent task began
- `task_progress` — agent is working (last tool name, usage)
- `task_notification` — agent completed (status, summary, usage)
- These appear in the `TaskSidebar` as real-time progress indicators

## Code conventions

### TypeScript

- Strict mode everywhere (`"strict": true`)
- No `any` — use `unknown` + type guards
- Interfaces for data shapes, types for unions and utilities
- No TypeScript enums — use `as const` + inferred type

```typescript
const INSTANCE_STATUS = {
  PROCESSING: 'processing',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  EXITED: 'exited',
} as const;
type InstanceStatus = typeof INSTANCE_STATUS[keyof typeof INSTANCE_STATUS];
```

### Naming

- Files: `kebab-case.ts` (e.g. `stream-process.ts`, `ChatView.tsx` for React components)
- Variables/functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- React components: `PascalCase` for both file and component name

### Backend

- Each service is a class with constructor dependency injection
- Express routes grouped in `routes.ts`, socket.io handlers in `stream-socket.ts`
- Services emit events via internal EventEmitter for decoupling
- Error handling: explicit try/catch, no unhandled promises
- Logging via `console.log` with `[service-name]` prefix
- ESM modules (`"type": "module"` in package.json)

```typescript
export class StreamProcessManager extends EventEmitter {
  constructor(private config: AppConfig, private taskStore?: TaskStore) { super(); }

  async createInstance(options: SpawnOptions): Promise<StreamInstance> { /* ... */ }
  async sendMessage(instanceId: string, prompt: string, options?: SendOptions): Promise<void> { /* ... */ }
  async kill(instanceId: string): Promise<void> { /* ... */ }
  async getContextUsage(instanceId: string): Promise<unknown> { /* ... */ }
  async getSupportedModels(instanceId: string): Promise<unknown[]> { /* ... */ }
  async rewindFiles(instanceId: string, userMessageId: string, dryRun?: boolean): Promise<unknown> { /* ... */ }
}
```

### Frontend

- Functional components only, no React classes
- One component per file, default export
- Custom hooks in `hooks/` for reusable logic
- Minimal global state — local state + props drilling; no Redux/Zustand
- Tailwind only for styling, no custom CSS except edge cases (xterm.js)

### Error handling

- Backend: return `{ error: string }` objects with the correct HTTP status code
- Frontend: display errors inline or in notifications, never silently
- Always log backend errors with context (instanceId, projectPath, etc.)

## Communication Backend <> Frontend

### REST (Express)

| Method | Route | Usage |
|--------|-------|-------|
| GET | `/api/health` | Health check |
| GET | `/api/config` | Read config |
| PUT | `/api/config` | Update config |
| GET | `/api/projects` | List detected projects |
| POST | `/api/projects/refresh` | Re-trigger scan |
| GET | `/api/suggest-paths` | Suggest scan directories |
| GET | `/api/browse?path=` | Browse directory listing |
| GET | `/api/instances` | List active instances |
| POST | `/api/instances` | Create instance `{ projectPath, taskDescription }` |
| DELETE | `/api/instances/:id` | Kill instance (`?deleteWorktree=true`) |
| GET | `/api/instances/:id/messages` | Message history |
| POST | `/api/instances/:id/messages` | Send message `{ prompt, model, permissionMode, effort, context, hidden }` |
| POST | `/api/instances/:id/interrupt` | Stop current generation |
| POST | `/api/instances/:id/clear` | Clear/reset session |
| POST | `/api/instances/:id/allow-tool` | Approve tool `{ toolName, scope }` |
| GET | `/api/instances/:id/permissions` | Get tool permissions (all scopes) |
| GET | `/api/instances/:id/context/files` | List files in project |
| GET | `/api/instances/:id/context/symbols` | Search for symbols `?q=query` |
| POST | `/api/instances/:id/context/file-content` | Read file content |
| GET | `/api/instances/:id/context/branches` | Git branches |
| GET | `/api/instances/:id/context/commits` | Recent commits |
| GET | `/api/instances/:id/context/changes` | Git status + diff summary |
| POST | `/api/instances/:id/context/diff` | File-specific diff |
| POST | `/api/instances/:id/context/revert` | Revert file changes |
| GET | `/api/instances/:id/context-usage` | Token breakdown by category (SDK) |
| GET | `/api/instances/:id/models` | Supported models (SDK) |
| POST | `/api/instances/:id/rewind` | Rewind files to message state `{ userMessageId, dryRun }` |
| GET | `/api/instances/:id/git/status` | Branch, uncommitted, unpushed info |
| POST | `/api/instances/:id/git/commit` | Commit `{ message, files? }` |
| POST | `/api/instances/:id/git/push` | Push branch to origin |
| POST | `/api/instances/:id/git/create-pr` | Create PR via gh `{ title, body?, baseBranch? }` |
| POST | `/api/instances/:id/git/merge-to-main` | Squash merge worktree to main `{ commitMessage? }` |
| DELETE | `/api/worktrees` | Delete git worktree |
| GET | `/api/tasks` | Task history (with worktreeExists flag) |
| DELETE | `/api/tasks/:id` | Remove task from history |
| GET | `/api/tasks/orphaned` | Tasks with worktrees still on disk |
| POST | `/api/tasks/:id/resume` | Resume orphaned task |
| GET | `/api/slash-commands` | Cached slash commands |
| GET | `/api/marketplace/plugins` | List plugins `?marketplace=&search=` |
| GET | `/api/marketplace/plugins/:mkt/:name` | Plugin detail |
| GET | `/api/marketplace/plugins/:mkt/:name/skills/:skill` | Skill detail |
| POST | `/api/marketplace/plugins/:mkt/:name/install` | Install plugin |
| POST | `/api/marketplace/plugins/:mkt/:name/uninstall` | Uninstall plugin |
| GET | `/api/marketplace/installed` | List installed plugins |
| POST | `/api/marketplace/refresh` | Refresh marketplace data |
| GET | `/api/rtk/status` | RTK status (installed, version, hooks) |
| POST | `/api/rtk/install-hooks` | Install RTK hooks globally |
| POST | `/api/rtk/uninstall-hooks` | Uninstall RTK hooks |
| GET | `/api/rtk/stats` | RTK compression stats |
| GET | `/api/rtk/graph` | RTK savings graph |
| GET | `/api/rtk/history` | RTK history |
| GET | `/api/rtk/discover` | RTK discover |

### WebSocket (socket.io)

Socket events use room-based scoping: clients join `instance:{id}` rooms.

| Event | Direction | Payload | Usage |
|-------|-----------|---------|-------|
| `instance:join` | client -> server | `{ instanceId }` | Join instance room |
| `instance:leave` | client -> server | `{ instanceId }` | Leave instance room |
| `chat:send` | client -> server | `{ instanceId, prompt }` | Send chat message |
| `chat:approve_tool` | client -> server | `{ instanceId, toolName }` | Always-allow tool |
| `chat:resolve_permission` | client -> server | `{ instanceId, toolUseId, allow, message? }` | Allow/deny specific tool call |
| `chat:resolve_question` | client -> server | `{ instanceId, toolUseId, answer }` | Answer AskUserQuestion |
| `chat:history` | client -> server | `{ instanceId }` | Request message history |
| `chat:stream_delta` | server -> client | `{ instanceId, text?, thinking?, type?, blockType?, blockName? }` | Streaming text/thinking chunk |
| `chat:tool_progress` | server -> client | `{ instanceId, toolUseId, toolName, elapsedSeconds }` | Tool execution progress |
| `chat:content_block` | server -> client | `{ instanceId, block }` | Complete content block |
| `chat:message` | server -> client | `{ instanceId, message }` | Complete message |
| `chat:session` | server -> client | `{ instanceId, sessionId, model, tools, mcpServers, permissionMode, cliVersion, slashCommands }` | Session metadata |
| `chat:result` | server -> client | `{ instanceId, costUsd, durationMs, stopReason, inputTokens, outputTokens, totalInputTokens, totalOutputTokens }` | Turn result |
| `chat:rate_limit` | server -> client | `{ instanceId, status, resetsAt?, rateLimitType? }` | Rate limit info |
| `chat:user_question` | server -> client | `{ instanceId, toolUseId, questions }` | AskUserQuestion from Claude |
| `chat:permission_request` | server -> client | `{ instanceId, toolName, toolInput, toolUseId, filePath?, title?, description? }` | Permission request |
| `chat:error` | server -> client | `{ instanceId, error }` | Error message |
| `agent:event` | server -> client | `{ instanceId, event, taskId, toolUseId?, description?, ... }` | Agent task lifecycle (broadcast) |
| `instance:status` | server -> client | `{ instanceId, status }` | Status change (broadcast) |
| `instance:exited` | server -> client | `{ instanceId, exitCode }` | Process terminated (broadcast) |

## Key interfaces

```typescript
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

interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp: string;
  contextAttachments?: ContextAttachment[];
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
  structuredPatch?: Array<{
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    lines: string[];
  }>;
}

interface AppConfig {
  scanPaths: string[];
  projectMarkers: string[];
  scanDepth: number;
  port: number;
  maxInstances: number;
  statusPatterns: { waitingInput: string[] };
}

interface StoredTask {
  id: string;
  projectPath: string;
  projectName: string;
  taskDescription: string | null;
  worktreePath: string | null;
  parentProjectPath: string | null;
  branchName: string | null;
  sessionId: string | null;
  status: 'active' | 'exited';
  createdAt: string;
  exitedAt: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
}

interface RtkStatus {
  installed: boolean;
  version: string | null;
  hooksInstalled: boolean;
  hookDetails: string;
}

interface RtkStats {
  totalTokensSaved: number;
  totalTokensOriginal: number;
  savingsPercent: number;
  commandCount: number;
  raw?: unknown;
}
```

## Data persistence

| Data | Location |
|------|----------|
| App config | `~/.claude-dashboard/config.json` |
| Task history | `~/.claude-dashboard/tasks.json` |
| Message history | `~/.claude-dashboard/messages/{instanceId}.json` |
| Agent SDK sessions | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` |
| Marketplace metadata | `~/.claude/plugins/known_marketplaces.json` |
| Plugin install state | `~/.claude/settings.json` |

## Key features

### Chat interface (`ChatView.tsx`)

- Real-time message streaming with content block rendering
- **Thinking blocks** — collapsible violet-tinted panels showing Claude's reasoning (streamed live)
- **Tool progress** — real-time elapsed time during long tool runs ("Running bash 12s...")
- **Structured patch rendering** — SDK's hunk-based diffs with proper line numbers
- **Context usage bar** — color-coded progress bar showing % of context window used
- Model selector: Opus, Sonnet, Haiku
- Permission mode selector: plan, ask, auto-edit, full-access
- Effort level selector: high, medium, low
- Context attachment panel: attach files, branches, commits, or git changes
- Slash command autocomplete with team:skill badge syntax
- @ mention search for files in project
- Permission request dialog with canUseTool callback (approve per-session or per-project)
- User question prompt for `AskUserQuestion` tool responses
- Markdown rendering with syntax highlighting
- Message deduplication (prevents identical assistant messages from retry loops)

### RTK token compression (`RtkStatusIndicator.tsx`)

- Auto-detects RTK binary on machine
- One-click hook installation (`rtk init -g --auto-patch`)
- Real-time savings display (tokens saved, % compression)
- Expandable stats panel with progress bar
- Uninstall capability

### Git workflow (`TaskChangesPanel.tsx`)

- View git diff for instance's working directory
- File-level change list with status indicators
- Revert individual files
- Commit with file selection
- Push to remote
- Create pull request via `gh pr create`
- Squash merge worktree branch to main
- Worktree cleanup after merge

### Marketplace (`MarketplacePanel.tsx`)

- Multiple marketplace sources (GitHub repos, directory-based)
- Plugin search and filtering by marketplace
- Install/uninstall with UI feedback
- Skill detail viewer with SKILL.md content and SCOPE.yaml constraints

### Task history and resumption

- Tasks persisted across sessions with project path, worktree info, timestamps, cost/tokens
- Orphaned task detection (worktree exists but no running instance)
- Resume capability for interrupted tasks (migrates messages, creates new instance)

### Attention queue

- Instances waiting for input are queued
- Auto-routes focus to front of queue
- Tab key cycles through queue
- Skip/jump controls

### Keyboard shortcuts

- `Cmd+1-9` — switch between active tasks
- `Cmd+N` — new task
- `Cmd+Enter` — send message / approve permission
- `Cmd+Shift+W` — kill current task
- `Tab` — accept autocomplete / cycle attention queue

## Constraints and limits

- The `claude` CLI must be in PATH (Agent SDK resolves it)
- Maximum 10 simultaneous instances by default (configurable)
- Message history per instance persisted to disk (no memory cap)
- Slash commands are cached; refresh via `/api/slash-commands` or on instance spawn
- Rate limit events displayed in topbar with reset time

## Design

- Dark theme — dev tool aesthetic
- Palette: black/very dark grey background (#0a0a0a, #1a1a1a), green/blue accents for statuses
- Violet accents for thinking blocks
- Amber accents for rate limits and RTK prompts
- Monospace for code blocks, sans-serif (Inter or system) for UI
- Icons: lucide-react exclusively
- Minimal animations — short CSS transitions (150ms) for status changes
- Right sidebar (~280px) for projects, changes, and marketplace (tabbed)
- Left sidebar for active tasks and agent progress
- PWA support with Workbox caching

## What NOT to do

- Do not store state in global variables — everything goes through services
- Do not poll HTTP for streaming output — WebSocket only
- Do not add heavy dependencies (ORM, CSS framework, state manager) without clear justification
- Do not bypass permission modes — always respect the user's chosen permission level
- Do not cache stale session data — always verify session validity on resume
- Do not return `{ behavior: 'allow' }` from `canUseTool` without `updatedInput` — SDK validates it
