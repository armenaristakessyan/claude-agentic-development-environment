import { File, FileText, FileJson, FileCode, FileType, Folder, ChevronRight, ChevronDown, Hash, Database, Globe, Paintbrush, Terminal, Cog, Image, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// --- File tree types ---

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileTreeNode[];
}

export function buildFileTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of files) {
    const parts = filePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');

      let existing = current.find(n => n.name === name);
      if (!existing) {
        existing = {
          name,
          path,
          type: isFile ? 'file' : 'folder',
          children: isFile ? undefined : [],
        };
        current.push(existing);
      }
      if (!isFile) {
        current = existing.children!;
      }
    }
  }

  // Sort: folders first, then alphabetical
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  };
  sortNodes(root);
  return root;
}

// --- Language detection ---

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', scala: 'scala',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'objectivec',
  sh: 'bash', zsh: 'bash', bash: 'bash', fish: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', htm: 'html', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'sass',
  md: 'markdown', mdx: 'mdx',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'docker', docker: 'docker',
  makefile: 'makefile', cmake: 'cmake',
  lua: 'lua', php: 'php', r: 'r', dart: 'dart',
  zig: 'zig', nim: 'nim', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hs: 'haskell', ml: 'ocaml',
  tf: 'hcl', hcl: 'hcl',
  proto: 'protobuf',
  ini: 'ini', cfg: 'ini', conf: 'ini',
  env: 'bash',
};

const FILENAME_TO_LANG: Record<string, string> = {
  'Dockerfile': 'docker', 'Makefile': 'makefile', 'CMakeLists.txt': 'cmake',
  '.gitignore': 'git', '.dockerignore': 'docker',
  'Cargo.toml': 'toml', 'Cargo.lock': 'toml',
  'package.json': 'json', 'tsconfig.json': 'json',
};

export function detectLanguage(filePath: string): string {
  const fileName = filePath.split('/').pop() ?? '';
  if (FILENAME_TO_LANG[fileName]) return FILENAME_TO_LANG[fileName];
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'text';
}

// --- File icon by language/extension ---

const ICON_MAP: Record<string, { icon: LucideIcon; color: string }> = {
  typescript: { icon: FileCode, color: 'text-blue-400' },
  tsx: { icon: FileCode, color: 'text-blue-400' },
  javascript: { icon: FileCode, color: 'text-yellow-400' },
  jsx: { icon: FileCode, color: 'text-yellow-400' },
  python: { icon: FileCode, color: 'text-green-400' },
  rust: { icon: Cog, color: 'text-orange-400' },
  go: { icon: FileCode, color: 'text-cyan-400' },
  java: { icon: FileCode, color: 'text-red-400' },
  kotlin: { icon: FileCode, color: 'text-violet-400' },
  csharp: { icon: FileCode, color: 'text-green-500' },
  swift: { icon: FileCode, color: 'text-orange-400' },
  c: { icon: FileCode, color: 'text-blue-300' },
  cpp: { icon: FileCode, color: 'text-blue-500' },
  ruby: { icon: FileCode, color: 'text-red-400' },
  php: { icon: FileCode, color: 'text-indigo-400' },
  dart: { icon: FileCode, color: 'text-cyan-400' },
  elixir: { icon: FileCode, color: 'text-violet-400' },
  haskell: { icon: FileCode, color: 'text-violet-300' },
  lua: { icon: FileCode, color: 'text-blue-400' },
  zig: { icon: FileCode, color: 'text-amber-400' },
  scala: { icon: FileCode, color: 'text-red-300' },
  html: { icon: Globe, color: 'text-orange-400' },
  css: { icon: Paintbrush, color: 'text-blue-400' },
  scss: { icon: Paintbrush, color: 'text-pink-400' },
  less: { icon: Paintbrush, color: 'text-blue-300' },
  sass: { icon: Paintbrush, color: 'text-pink-400' },
  json: { icon: FileJson, color: 'text-yellow-300' },
  yaml: { icon: FileText, color: 'text-red-300' },
  toml: { icon: FileText, color: 'text-gray-400' },
  xml: { icon: FileCode, color: 'text-orange-300' },
  markdown: { icon: FileText, color: 'text-blue-200' },
  mdx: { icon: FileText, color: 'text-blue-200' },
  sql: { icon: Database, color: 'text-blue-300' },
  graphql: { icon: Hash, color: 'text-pink-400' },
  docker: { icon: FileCode, color: 'text-cyan-400' },
  bash: { icon: Terminal, color: 'text-green-300' },
  makefile: { icon: Terminal, color: 'text-gray-400' },
  git: { icon: FileText, color: 'text-orange-300' },
  hcl: { icon: FileCode, color: 'text-violet-400' },
  protobuf: { icon: FileCode, color: 'text-green-400' },
  ini: { icon: Cog, color: 'text-gray-400' },
  svg: { icon: Image, color: 'text-amber-300' },
};

export function FileIcon({ fileName, className = 'h-3 w-3 shrink-0' }: { fileName: string; className?: string }) {
  const lang = detectLanguage(fileName);
  const entry = ICON_MAP[lang];
  if (entry) {
    const Icon = entry.icon;
    return <Icon className={`${className} ${entry.color}`} />;
  }
  return <File className={`${className} text-faint`} />;
}

// --- File tree renderer ---

export function FileTreeView({
  nodes,
  depth,
  expanded,
  selectedFile,
  onToggle,
  onSelect,
}: {
  nodes: FileTreeNode[];
  depth: number;
  expanded: Set<string>;
  selectedFile: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map(node => {
        if (node.type === 'folder') {
          const isExpanded = expanded.has(node.path);
          return (
            <div key={node.path}>
              <button
                onClick={() => onToggle(node.path)}
                className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-hover"
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
              >
                {isExpanded
                  ? <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
                  : <ChevronRight className="h-3 w-3 shrink-0 text-faint" />
                }
                <Folder className={`h-3 w-3 shrink-0 ${isExpanded ? 'text-tertiary' : 'text-muted'}`} />
                <span className="truncate text-[11px] text-tertiary">{node.name}</span>
              </button>
              {isExpanded && node.children && (
                <FileTreeView
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  selectedFile={selectedFile}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        }

        return (
          <button
            key={node.path}
            onClick={() => onSelect(node.path)}
            className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors ${
              selectedFile === node.path ? 'bg-blue-500/15 text-primary' : 'text-tertiary hover:bg-hover'
            }`}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            <span className="w-3 shrink-0" />
            <FileIcon fileName={node.name} />
            <span className="truncate text-[11px]">{node.name}</span>
          </button>
        );
      })}
    </>
  );
}
