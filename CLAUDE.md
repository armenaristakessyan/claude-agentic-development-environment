# CLAUDE.md — Claude ADE

## Project

Claude ADE (Agentic Development Environment) is a local web dashboard for orchestrating multiple Claude Code instances in parallel. It scans local projects, spawns Claude Code instances in PTYs, and lets you interact with them via embedded terminals in the browser.

## Stack

- **Monorepo** with npm workspaces: `packages/backend` + `packages/frontend`
- **Backend**: Node.js, TypeScript, Express, socket.io, node-pty
- **Frontend**: React (Vite), TypeScript, Tailwind CSS, xterm.js, socket.io-client, lucide-react
- **Target**: macOS only (node-pty + Xcode CLI tools)

## Commands

- `npm run dev` — start backend + frontend in parallel (concurrently)
- `npm run dev:backend` — start backend only (ts-node / tsx)
- `npm run dev:frontend` — start frontend only (vite)
- `npm run build` — production build for both packages
- `npm run lint` — ESLint across the monorepo
- `npm run typecheck` — TypeScript check without emit

## Structure

```
claude-agentic-development-environment/
├── CLAUDE.md
├── package.json                    # workspace root
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts            # Express + socket.io entry point
│   │   │   ├── config.ts           # read/write config ~/.claude-dashboard/config.json
│   │   │   ├── scanner.ts          # ProjectScanner: project + worktree detection
│   │   │   ├── process-manager.ts  # ProcessManager: spawn/kill PTY, lifecycle
│   │   │   ├── status-monitor.ts   # StatusMonitor: PTY output parsing, status detection
│   │   │   ├── worktree-manager.ts # WorktreeManager: git worktree create/delete
│   │   │   ├── routes.ts           # Express REST routes
│   │   │   └── socket.ts           # socket.io WebSocket handlers
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── frontend/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   ├── components/
│       │   │   ├── AttentionQueueBanner.tsx  # banner for instances needing attention
│       │   │   ├── ContextBanner.tsx         # context/status banner
│       │   │   ├── InstanceList.tsx          # list of active Claude instances
│       │   │   ├── LaunchModal.tsx           # modal to spawn a new instance
│       │   │   ├── ProjectList.tsx           # list of scanned projects
│       │   │   ├── ScanPathsModal.tsx        # modal to edit scan paths
│       │   │   ├── Sidebar.tsx               # right sidebar (projects + instances)
│       │   │   └── TerminalView.tsx          # xterm.js terminal embed
│       │   ├── hooks/
│       │   │   ├── useAttentionQueue.ts      # queue of instances waiting for input
│       │   │   ├── useConfig.ts              # read/update app config
│       │   │   ├── useInstances.ts           # instance CRUD + socket events
│       │   │   ├── useProjects.ts            # project list + worktree deletion
│       │   │   └── useSocket.ts             # socket.io connection
│       │   └── types.ts            # shared frontend types
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── tailwind.config.js
└── README.md
```

## Code conventions

### TypeScript

- Strict mode everywhere (`"strict": true`)
- No `any` — use `unknown` + type guards where needed
- Interfaces for data shapes, types for unions and utilities
- No TypeScript enums — use `as const` + inferred types

```typescript
// Good
const INSTANCE_STATUS = {
  LAUNCHING: 'launching',
  PROCESSING: 'processing',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  EXITED: 'exited',
} as const;
type InstanceStatus = typeof INSTANCE_STATUS[keyof typeof INSTANCE_STATUS];

// Bad
enum InstanceStatus { LAUNCHING, PROCESSING }
```

### Naming

- Files: `kebab-case.ts` (e.g. `process-manager.ts`, `TerminalView.tsx` for React components)
- Variables/functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- React components: `PascalCase` for both file and component name

### Backend

- Each service is a class with constructor dependency injection
- Express routes are grouped in `routes.ts`, socket.io handlers in `socket.ts`
- Services emit events via an internal EventEmitter for decoupling
- Error handling: explicit try/catch, no unhandled promises
- Logging via `console.log` with `[service-name]` prefix — no logging library for MVP

```typescript
// Service pattern
export class ProcessManager {
  constructor(
    private config: AppConfig,
    private statusMonitor: StatusMonitor,
  ) {}

  async spawn(projectPath: string): Promise<Instance> { /* ... */ }
  async kill(instanceId: string): Promise<void> { /* ... */ }
}
```

### Frontend

- Functional components only, no React classes
- One component per file, default export
- Custom hooks in `hooks/` for any reusable logic
- Minimal global state — prefer local state + props drilling for MVP; no Redux/Zustand unless complexity demands it
- Tailwind only for styling, no custom CSS except edge cases (xterm.js)

### Error handling

- Backend: return `{ error: string }` objects with the correct HTTP status code
- Frontend: display errors in a toast/notification, never silently
- Always log backend errors with context (instanceId, projectPath, etc.)

## Backend ↔ Frontend communication

### REST (Express)

Used for CRUD operations and one-off requests:

| Method | Route | Usage |
|--------|-------|-------|
| GET | `/api/config` | Read config |
| PUT | `/api/config` | Update config |
| GET | `/api/projects` | List detected projects |
| POST | `/api/projects/refresh` | Re-trigger scan |
| DELETE | `/api/projects/:path/worktree` | Delete a git worktree |
| GET | `/api/instances` | List active instances |
| POST | `/api/instances` | Spawn an instance `{ projectPath }` |
| DELETE | `/api/instances/:id` | Kill an instance |

### WebSocket (socket.io)

Used for real-time streaming:

| Event | Direction | Payload | Usage |
|-------|-----------|---------|-------|
| `terminal:attach` | client → server | `{ instanceId }` | Subscribe to an instance's stream |
| `terminal:detach` | client → server | `{ instanceId }` | Unsubscribe |
| `terminal:input` | client → server | `{ instanceId, data }` | Send text to the PTY |
| `terminal:resize` | client → server | `{ instanceId, cols, rows }` | Resize the PTY |
| `terminal:output` | server → client | `{ instanceId, data }` | PTY output |
| `terminal:history` | server → client | `{ instanceId, data }` | History buffer on attach |
| `instance:status` | server → client | `{ instanceId, status }` | Status change |
| `instance:exited` | server → client | `{ instanceId, exitCode }` | Process terminated |

## Key interfaces

```typescript
interface Project {
  name: string;
  path: string;
  gitBranch: string | null;
  hasClaudeMd: boolean;
  lastModified: Date;
  isWorktree: boolean;
  parentProject?: string; // if worktree, path of the main repo
}

interface Instance {
  id: string;
  projectPath: string;
  projectName: string;
  pid: number;
  status: InstanceStatus;
  createdAt: Date;
  lastActivity: Date;
}

interface AppConfig {
  scanPaths: string[];
  projectMarkers: string[];
  scanDepth: number;
  port: number;
  maxInstances: number;
  statusPatterns: {
    waitingInput: string[]; // regex patterns to detect the Claude prompt
  };
}
```

## Constraints and limits

- The `claude` binary must be in PATH
- Maximum 10 simultaneous instances by default (configurable) — each PTY consumes a file descriptor
- History buffer per instance is capped at 5000 lines
- node-pty requires Xcode CLI tools (`xcode-select --install`)
- Status detection is heuristic — Claude Code prompt patterns may change between versions

## Design

- Dark theme required — this is a dev tool, not a consumer app
- Palette: black/very dark grey background (#0a0a0a, #1a1a1a), green/blue accents for statuses
- Monospace typography for terminals, sans-serif (Inter or system) for UI
- Icons: lucide-react exclusively
- Minimal animations — short CSS transitions (150ms) for status changes
- Sidebar: fixed width ~280px, positioned on the **right**

## What NOT to do

- Do not use `child_process.spawn` directly — always go through `node-pty` for a real PTY
- Do not store state in global variables — everything goes through services
- Do not poll HTTP for terminal output — WebSocket only
- Do not try to parse Claude Code's JSON output — work with the raw terminal stream
- Do not add heavy dependencies (ORM, CSS framework, state manager) without clear justification
