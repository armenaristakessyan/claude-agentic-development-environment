# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Claude ADE (Agentic Development Environment) is a local dashboard for orchestrating multiple Claude Code instances in parallel. It uses `@anthropic-ai/claude-agent-sdk` to manage persistent conversations with full Claude Code agent behavior (tools, CLAUDE.md, MCP). The UI provides real-time streaming, thinking blocks, tool progress, context attachments, permission management, task history, a plugin marketplace, and RTK token-compression integration. Ships as a web dashboard and an Electron desktop app.

## Stack

- **Monorepo** — npm workspaces: `packages/backend` + `packages/frontend` (+ top-level `electron/`)
- **Backend** — Node.js, TypeScript (ESM), Express, socket.io, `@anthropic-ai/claude-agent-sdk`, simple-git, node-pty
- **Frontend** — React 19 (Vite), TypeScript, Tailwind CSS 4, xterm.js, socket.io-client, lucide-react, react-markdown
- **Desktop** — Electron 35 (bundled via esbuild → `electron/dist/`), electron-builder for `.dmg`
- **Target** — macOS (requires `claude` CLI in PATH; node-pty needs Xcode CLI tools)

## Commands

- `npm run dev` — start backend + frontend (web mode, vite @ 5173, backend @ 3000)
- `npm run dev:backend` / `npm run dev:frontend` — start individually
- `npm run dev:electron` — backend + frontend + Electron shell
- `npm run build` — production build both packages
- `npm run build:electron` — build packages + bundle Electron main/preload with esbuild
- `npm run package` — build + produce macOS `.dmg` via electron-builder
- `npm run typecheck` — tsc `--noEmit` for both packages
- `npm run lint` — ESLint across `packages/*/src/**/*.{ts,tsx}`

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
- **`canUseTool` callback** — emits `permission_request` to frontend, waits for response, returns allow/deny
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

## Structure

```
packages/
├── backend/src/
│   ├── index.ts            # Express + socket.io entry, service wiring
│   ├── config.ts           # Read/write ~/.claude-dashboard/config.json
│   ├── scanner.ts          # ProjectScanner: project + worktree detection
│   ├── stream-process.ts   # StreamProcessManager: Agent SDK query(), canUseTool, streaming
│   ├── stream-socket.ts    # Socket.io WebSocket handlers for chat events
│   ├── task-store.ts       # Task + message persistence
│   ├── worktree-manager.ts # Git worktree create/delete
│   ├── marketplace.ts      # Plugin discovery, install/uninstall
│   ├── rtk-service.ts      # RTK token compression integration
│   ├── routes.ts           # REST API endpoints (~50 routes)
│   ├── process-manager.ts  # (legacy) PTY-based process manager
│   ├── status-monitor.ts   # (legacy) PTY output parsing
│   └── socket.ts           # (legacy) PTY socket handlers
└── frontend/src/
    ├── App.tsx              # Root: 3-column layout, topbar, hotkeys
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
electron/
├── main.ts                  # Electron main process (spawns backend, loads frontend)
└── preload.ts               # Context bridge
```

## Communication

### REST API (`routes.ts`)

- **Config**: `GET/PUT /api/config`
- **Projects**: `GET /api/projects`, `POST /api/projects/refresh`, `GET /api/browse`
- **Instances**: CRUD at `/api/instances/:id`, messages, interrupt, clear, permissions
- **Context**: `/api/instances/:id/context/{files,symbols,branches,commits,changes,diff,revert}`
- **Git**: `/api/instances/:id/git/{status,commit,push,create-pr,merge-to-main}`
- **Tasks**: `GET /api/tasks`, resume, orphaned detection
- **Marketplace**: `/api/marketplace/plugins`, install/uninstall, skills
- **RTK**: `/api/rtk/{status,stats,graph,history,install-hooks,uninstall-hooks}`

### WebSocket (`stream-socket.ts`)

Room-based scoping: clients join `instance:{id}`.
- **Client → Server**: `instance:join/leave`, `chat:send`, `chat:resolve_permission`, `chat:resolve_question`, `chat:approve_tool`
- **Server → Client**: `chat:stream_delta`, `chat:tool_progress`, `chat:content_block`, `chat:message`, `chat:result`, `chat:session`, `chat:permission_request`, `chat:user_question`, `chat:error`, `chat:rate_limit`, `agent:event`, `instance:status/exited`

## Code conventions

- **TypeScript**: strict mode, no `any` (use `unknown` + type guards); interfaces for shapes, types for unions; no enums — use `as const` + inferred types.
- **Naming**: files `kebab-case.ts`, components `PascalCase.tsx`, vars/funcs `camelCase`, types `PascalCase`, constants `UPPER_SNAKE_CASE`.
- **Backend**: classes with constructor DI; services emit events via EventEmitter; explicit try/catch; log with `[service-name]` prefix; ESM (`"type": "module"`).
- **Frontend**: functional components, one per file, default export; hooks in `hooks/` for reusable logic; local state + props drilling (no Redux/Zustand); Tailwind only (no custom CSS except xterm.js edge cases); `ThemeContext` for dark/light.
- **Errors**: backend returns `{ error: string }` with correct HTTP status; frontend displays inline, never silently swallows; always log with context (instanceId, projectPath).

## Data persistence

| Data | Location |
|------|----------|
| App config | `~/.claude-dashboard/config.json` |
| Task history | `~/.claude-dashboard/tasks.json` |
| Message history | `~/.claude-dashboard/messages/{instanceId}.json` |
| SDK sessions | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` |
| Marketplace | `~/.claude/plugins/known_marketplaces.json` |
| Plugin state | `~/.claude/settings.json` |

**Note**: `~/.claude-dashboard/*` files are read by the production build; any schema change must be additive and migrated, never breaking.

## Design

- Dark/light theme with dev-tool aesthetic; dark palette `#0a0a0a`/`#1a1a1a` bg, green/blue status accents, violet thinking blocks, amber rate-limits/RTK.
- Icons: lucide-react exclusively.
- 3-column layout: left sidebar (tasks), center (chat), right sidebar (projects/changes/marketplace/terminal).
- PWA with Workbox caching in web mode.

## Keyboard shortcuts

`Cmd+1-9` switch tasks · `Cmd+N` new task · `Cmd+Enter` send/approve · `Cmd+Shift+W` kill task · `Tab` autocomplete / cycle attention queue.

## Constraints

- `claude` CLI must be in PATH.
- Max 10 simultaneous instances (configurable).
- Never return `{ behavior: 'allow' }` from `canUseTool` without `updatedInput`.
- Do not poll HTTP for streaming — WebSocket only.
- Do not store state in module globals — use services.
- Do not bypass permission modes.
- Do not cache stale session data — verify on resume.
- Do not add heavy deps (ORM, CSS framework, state manager) without justification.
