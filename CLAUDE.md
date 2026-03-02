# CLAUDE.md — Claude Code Dashboard

## Projet

Dashboard web local pour orchestrer plusieurs instances Claude Code en parallèle. Permet de scanner des projets locaux, lancer des instances Claude Code dans des PTY, et interagir avec elles via des terminaux embarqués dans le navigateur.

## Stack

- **Monorepo** avec npm workspaces : `packages/backend` + `packages/frontend`
- **Backend** : Node.js, TypeScript, Express, socket.io, node-pty
- **Frontend** : React (Vite), TypeScript, Tailwind CSS, xterm.js, socket.io-client, lucide-react
- **Cible** : macOS uniquement (node-pty + Xcode CLI tools)

## Commandes

- `npm run dev` — lance backend + frontend en parallèle (concurrently)
- `npm run dev:backend` — lance uniquement le backend (ts-node ou tsx)
- `npm run dev:frontend` — lance uniquement le frontend (vite)
- `npm run build` — build de production des deux packages
- `npm run lint` — ESLint sur tout le monorepo
- `npm run typecheck` — vérification TypeScript sans émission

## Structure

```
claude-dashboard/
├── CLAUDE.md
├── package.json                    # workspace root
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts            # entry point Express + socket.io
│   │   │   ├── config.ts           # lecture/écriture config ~/.claude-dashboard/config.json
│   │   │   ├── scanner.ts          # ProjectScanner : détection projets + worktrees
│   │   │   ├── process-manager.ts  # ProcessManager : spawn/kill PTY, lifecycle
│   │   │   ├── status-monitor.ts   # StatusMonitor : parsing output PTY, détection état
│   │   │   ├── routes.ts           # routes REST Express
│   │   │   └── socket.ts          # handlers WebSocket socket.io
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── frontend/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   ├── components/         # composants React
│       │   ├── hooks/              # custom hooks (useSocket, useInstances, etc.)
│       │   └── types.ts            # types partagés frontend
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── tailwind.config.js
└── README.md
```

## Conventions de code

### TypeScript

- Strict mode activé partout (`"strict": true`)
- Pas de `any` — utiliser `unknown` + type guards si nécessaire
- Interfaces pour les shapes de données, types pour les unions et utilitaires
- Pas d'enums TypeScript — utiliser `as const` + type inféré

```typescript
// Bon
const INSTANCE_STATUS = {
  LAUNCHING: 'launching',
  PROCESSING: 'processing',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  EXITED: 'exited',
} as const;
type InstanceStatus = typeof INSTANCE_STATUS[keyof typeof INSTANCE_STATUS];

// Mauvais
enum InstanceStatus { LAUNCHING, PROCESSING }
```

### Nommage

- Fichiers : `kebab-case.ts` (ex: `process-manager.ts`, `TerminalView.tsx` pour les composants React)
- Variables/fonctions : `camelCase`
- Types/Interfaces : `PascalCase`
- Constantes : `UPPER_SNAKE_CASE`
- Composants React : `PascalCase` pour le fichier ET le composant

### Backend

- Chaque service est une classe avec injection des dépendances par constructeur
- Les routes Express sont regroupées dans `routes.ts`, les handlers socket.io dans `socket.ts`
- Les services émettent des événements via un EventEmitter interne pour le découplage
- Gestion d'erreurs : try/catch explicite, jamais de promise non catchée
- Logs via `console.log` avec préfixe `[service-name]` — pas de lib de logging pour le MVP

```typescript
// Pattern service
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

- Composants fonctionnels uniquement, pas de classes React
- Un composant par fichier, export default
- Hooks custom dans `hooks/` pour toute logique réutilisable
- État global minimal — préférer le state local + props drilling pour le MVP, pas de Redux/Zustand sauf si la complexité l'exige
- Tailwind uniquement pour le styling, pas de CSS custom sauf cas exceptionnel (xterm.js)

### Gestion des erreurs

- Backend : retourner des objets `{ error: string }` avec le bon HTTP status code
- Frontend : afficher les erreurs dans un toast/notification, jamais silencieusement
- Toujours logger les erreurs côté backend avec le contexte (instanceId, projectPath, etc.)

## Communication Backend ↔ Frontend

### REST (Express)

Utilisé pour les opérations CRUD et les requêtes ponctuelles :

| Méthode | Route | Usage |
|---------|-------|-------|
| GET | `/api/config` | Lire la config |
| PUT | `/api/config` | Modifier la config |
| GET | `/api/projects` | Lister les projets détectés |
| POST | `/api/projects/refresh` | Relancer le scan |
| GET | `/api/instances` | Lister les instances actives |
| POST | `/api/instances` | Créer une instance `{ projectPath }` |
| DELETE | `/api/instances/:id` | Kill une instance |

### WebSocket (socket.io)

Utilisé pour le streaming temps réel :

| Event | Direction | Payload | Usage |
|-------|-----------|---------|-------|
| `terminal:attach` | client → server | `{ instanceId }` | S'abonner au flux d'une instance |
| `terminal:detach` | client → server | `{ instanceId }` | Se désabonner |
| `terminal:input` | client → server | `{ instanceId, data }` | Envoyer du texte au PTY |
| `terminal:resize` | client → server | `{ instanceId, cols, rows }` | Resize le PTY |
| `terminal:output` | server → client | `{ instanceId, data }` | Output du PTY |
| `terminal:history` | server → client | `{ instanceId, data }` | Buffer historique au attach |
| `instance:status` | server → client | `{ instanceId, status }` | Changement de statut |
| `instance:exited` | server → client | `{ instanceId, exitCode }` | Process terminé |

## Interfaces clés

```typescript
interface Project {
  name: string;
  path: string;
  gitBranch: string | null;
  hasClaudeMd: boolean;
  lastModified: Date;
  isWorktree: boolean;
  parentProject?: string; // si worktree, chemin du repo principal
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
    waitingInput: string[]; // regex patterns pour détecter le prompt
  };
}
```

## Contraintes et limites

- Le binaire `claude` doit être dans le PATH
- Maximum 10 instances simultanées par défaut (configurable) — chaque PTY consomme un file descriptor
- Le buffer historique par instance est limité à 5000 lignes
- node-pty nécessite les Xcode CLI tools (`xcode-select --install`)
- La détection de statut est heuristique — les patterns de prompt Claude Code peuvent changer entre versions

## Design

- Thème sombre obligatoire — le dashboard est un outil de dev, pas une app consumer
- Palette : fond noir/gris très foncé (#0a0a0a, #1a1a1a), accents verts/bleus pour les statuts
- Typographie monospace pour tout ce qui est terminal, sans-serif (Inter ou system) pour l'UI
- Icônes : lucide-react exclusivement
- Animations minimales — transitions CSS courtes (150ms) pour les changements de statut
- Sidebar : largeur fixe ~280px, collapsible

## Ce qu'il ne faut PAS faire

- Ne pas utiliser `child_process.spawn` directement — toujours passer par `node-pty` pour avoir un vrai PTY
- Ne pas stocker de state dans des variables globales — tout passe par les services
- Ne pas faire de polling HTTP pour le terminal — c'est du WebSocket uniquement
- Ne pas essayer de parser le JSON output de Claude Code — on travaille avec le flux terminal brut
- Ne pas ajouter de dépendances lourdes (ORM, framework CSS, state manager) sans justification claire
