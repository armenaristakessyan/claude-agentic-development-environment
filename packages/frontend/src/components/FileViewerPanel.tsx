import { Folder, ChevronRight, ChevronDown } from 'lucide-react';
import { getJbIconPath } from './jb-icons';
import { useTheme } from '../contexts/ThemeContext';

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

// --- File icon (JetBrains New UI, bundled from fogio-org/vscode-jetbrains-file-icon-theme) ---

export function FileIcon({ fileName, className = 'h-3 w-3 shrink-0' }: { fileName: string; className?: string }) {
  const { theme } = useTheme();
  return (
    <img
      src={getJbIconPath(fileName, theme)}
      alt=""
      className={className}
      draggable={false}
    />
  );
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
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-hover"
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
              >
                {isExpanded
                  ? <ChevronDown className="h-4 w-4 shrink-0 text-faint" />
                  : <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
                }
                <Folder className={`h-4 w-4 shrink-0 ${isExpanded ? 'text-tertiary' : 'text-muted'}`} />
                <span className="truncate text-[13px] text-tertiary">{node.name}</span>
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
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors ${
              selectedFile === node.path ? 'bg-blue-500/15 text-primary' : 'text-tertiary hover:bg-hover'
            }`}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            <span className="w-4 shrink-0" />
            <FileIcon fileName={node.name} className="h-4 w-4 shrink-0" />
            <span className="truncate text-[13px]">{node.name}</span>
          </button>
        );
      })}
    </>
  );
}
