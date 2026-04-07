# CLAUDE.md — Claude ADE (Agentic Development Environment)

## Project

Claude ADE is a local web dashboard for orchestrating multiple Claude Code instances in parallel. It uses `@anthropic-ai/claude-agent-sdk` to manage persistent conversations with full Claude Code agent behavior (tools, CLAUDE.md, MCP, etc.). It exposes a chat-based interface with real-time streaming, thinking blocks, tool progress, context attachments, permission management, task history, a plugin marketplace, and RTK token compression integration.

## Stack

- **Monorepo** — npm workspaces: `packages/backend` + `packages/frontend`
- **Backend** — Node.js, TypeScript (ESM), Express, socket.io, `@anthropic-ai/claude-agent-sdk`
- **Frontend** — React 19 (Vite), TypeScript, Tailwind CSS 4, xterm.js, socket.io-client, lucide-react, react-markdown
- **Target** — macOS (requires `claude` CLI in PATH)

## Commands

- `npm run dev` — start backend + frontend in parallel (concurrently)
- `npm run dev:backend` / `npm run dev:frontend` — start individually
- `npm run build` — production build for both packages
- `npm run typecheck` — TypeScript check without emit

## Structure

```
packages/
├── backend/src/
│   ├── index.ts            # Express + socket.io entry, service wiring
│   ├── config.ts           # Read/write ~/.claude-dashboard/config.json
│   ├── scanner.ts          # ProjectScanner: project + worktree detection
│   ├── stream-process.ts   # StreamProcessManager: Agent SDK query(), canUseTool, streaming
│   ├── stream-socket.ts    # Socket.io WebSocket handlers for chat events
│   ├── task-store.ts       # Task + message persistence to disk
│   ├── worktree-manager.ts # Git worktree create/delete
│   ├── marketplace.ts      # Plugin discovery, install/uninstall
│   ├── rtk-service.ts      # RTK token compression integration
│   ├── routes.ts           # All REST API endpoints (~50 routes)
│   ├── process-manager.ts  # (legacy) PTY-based process manager
│   ├── status-monitor.ts   # (legacy) PTY output parsing
│   └── socket.ts           # (legacy) PTY socket handlers
└── frontend/src/
    ├── App.tsx              # Root: 3-column layout, topbar, hotkeys
    ├── types.ts             # Shared frontend types
    ├── contexts/ThemeContext.tsx
    ├── components/          # ChatView, TaskSidebar, Sidebar, ProjectList,
    │                        # TaskChangesPanel, MarketplacePanel, PluginCard,
    │                        # PluginDetailModal, LaunchModal, ScanPathsModal,
    │                        # AttentionQueueBanner, ContextBanner, SettingsModal,
    │                        # RtkStatusIndicator, InstanceList, ResizeHandle,
    │                        # TerminalView (legacy)
    └── hooks/               # useSocket, useInstances, useProjects, useTaskHistory,
                             # useMarketplace, useAttentionQueue, useConfig,
                             # useHotkeys, useRtk
```

## Architecture

### Message flow

1. Frontend sends message via `POST /api/instances/:id/messages` (or `chat:send` socket)
2. `StreamProcessManager` pushes message into a live `query()` conversation
3. SDK streams events (`system`, `assistant`, `stream_event`, `tool_progress`, `result`, `rate_limit_event`)
4. Events emitted to socket.io room `instance:{id}`
5. On `result`, accumulated blocks are flushed as a `ChatMessage`, deduplicated, and persisted
6. On resume, messages loaded from disk; SDK resumes via `resume: sessionId`

### Agent SDK integration

- **One persistent `query()` per instance** — conversations stay alive across turns
- **`canUseTool` callback** — emits `permission_request` to frontend, waits for user response, returns allow/deny
- **`systemPrompt: { type: 'preset', preset: 'claude_code' }`** — full agent with tools, CLAUDE.md, MCP
- **`settingSources: ['project', 'local']`**, `enableFileCheckpointing: true`, `includePartialMessages: true`
- **`resume: sessionId`** — native session persistence
- **`conversation.interrupt()`** — clean interruption
- **`conversation.setModel()` / `setPermissionMode()`** — mid-session changes

### Instance lifecycle

`waiting_input` → `processing` (streaming/tools) → `waiting_input` (turn complete) → `exited` (closed/killed)

### Content blocks

Messages contain typed blocks streamed in real-time: `text`, `thinking`, `tool_use`, `tool_result` (with stdout, stderr, structuredPatch).

### Agent task tracking

Sub-agent lifecycle events (`task_started`, `task_progress`, `task_notification`) appear in `TaskSidebar` as real-time progress indicators.

## Communication

### REST API (`routes.ts`)

Routes are grouped by domain — see `routes.ts` for full reference:
- **Config**: `GET/PUT /api/config`
- **Projects**: `GET /api/projects`, `POST /api/projects/refresh`, `GET /api/browse`
- **Instances**: CRUD at `/api/instances/:id`, messages, interrupt, clear, permissions
- **Context**: `/api/instances/:id/context/{files,symbols,branches,commits,changes,diff,revert}`
- **Git**: `/api/instances/:id/git/{status,commit,push,create-pr,merge-to-main}`
- **Tasks**: `GET /api/tasks`, resume, orphaned detection
- **Marketplace**: `/api/marketplace/plugins`, install/uninstall, skills
- **RTK**: `/api/rtk/{status,stats,graph,history,install-hooks,uninstall-hooks}`

### WebSocket (`stream-socket.ts`)

Room-based scoping: clients join `instance:{id}`. See `stream-socket.ts` for full event list.
- **Client → Server**: `instance:join/leave`, `chat:send`, `chat:resolve_permission`, `chat:resolve_question`, `chat:approve_tool`
- **Server → Client**: `chat:stream_delta`, `chat:tool_progress`, `chat:content_block`, `chat:message`, `chat:result`, `chat:session`, `chat:permission_request`, `chat:user_question`, `chat:error`, `chat:rate_limit`, `agent:event`, `instance:status/exited`

## Code conventions

### TypeScript

- Strict mode everywhere, no `any` (use `unknown` + type guards)
- Interfaces for data shapes, types for unions/utilities
- No enums — use `as const` + inferred type

### Naming

- Files: `kebab-case.ts`, React components: `PascalCase.tsx`
- Variables/functions: `camelCase`, Types: `PascalCase`, Constants: `UPPER_SNAKE_CASE`

### Backend

- Services are classes with constructor dependency injection
- Routes in `routes.ts`, socket handlers in `stream-socket.ts`
- Services emit events via EventEmitter for decoupling
- Explicit try/catch, no unhandled promises
- Logging: `console.log` with `[service-name]` prefix
- ESM modules (`"type": "module"`)

### Frontend

- Functional components only, one per file, default export
- Hooks in `hooks/` for reusable logic
- Local state + props drilling — no Redux/Zustand
- Tailwind only for styling (no custom CSS except xterm.js edge cases)
- `ThemeContext` for dark/light theme

### Error handling

- Backend: return `{ error: string }` with correct HTTP status
- Frontend: display errors inline, never silently swallow
- Always log with context (instanceId, projectPath, etc.)

## Data persistence

| Data | Location |
|------|----------|
| App config | `~/.claude-dashboard/config.json` |
| Task history | `~/.claude-dashboard/tasks.json` |
| Message history | `~/.claude-dashboard/messages/{instanceId}.json` |
| SDK sessions | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` |
| Marketplace | `~/.claude/plugins/known_marketplaces.json` |
| Plugin state | `~/.claude/settings.json` |

## Design

- Dark/light theme — dev tool aesthetic
- Dark palette: #0a0a0a/#1a1a1a background, green/blue status accents, violet thinking blocks, amber rate limits/RTK
- Icons: lucide-react exclusively
- Minimal animations (150ms CSS transitions)
- 3-column layout: left sidebar (tasks), center (chat), right sidebar (projects/changes/marketplace)
- PWA support with Workbox caching

## Keyboard shortcuts

`Cmd+1-9` switch tasks, `Cmd+N` new task, `Cmd+Enter` send/approve, `Cmd+Shift+W` kill task, `Tab` autocomplete/cycle attention queue

## Constraints

- `claude` CLI must be in PATH
- Max 10 simultaneous instances (configurable via config)
- Message history persisted to disk (no memory cap)
- Never return `{ behavior: 'allow' }` from `canUseTool` without `updatedInput`
- Do not poll HTTP for streaming — WebSocket only
- Do not store state in global variables — use services
- Do not bypass permission modes
- Do not cache stale session data — verify on resume
- Do not add heavy deps (ORM, CSS framework, state manager) without justification
