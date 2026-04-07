import { useState, useMemo, useCallback, useRef } from 'react';
import { Play, GitBranch, FileText, Search, Loader2, Folder, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { Project, Instance } from '../types';
import LaunchModal from './LaunchModal';

// --- Tree types ---

interface FolderTreeNode {
  type: 'folder';
  name: string;
  fullPath: string;
  children: TreeNode[];
  projectCount: number;
}

interface ProjectTreeNode {
  type: 'project';
  project: Project;
}

type TreeNode = FolderTreeNode | ProjectTreeNode;

// --- Tree builder ---

function buildTree(projects: Project[], root: string): TreeNode[] {
  const tree: TreeNode[] = [];

  for (const project of projects) {
    if (!project.path.startsWith(root)) continue;

    const relative = project.path.slice(root.length + 1);
    if (!relative) {
      tree.push({ type: 'project', project });
      continue;
    }

    const segments = relative.split('/');
    let currentLevel = tree;

    for (let i = 0; i < segments.length - 1; i++) {
      const folderName = segments[i];
      const folderPath = root + '/' + segments.slice(0, i + 1).join('/');

      let existing = currentLevel.find(
        (n): n is FolderTreeNode => n.type === 'folder' && n.fullPath === folderPath,
      );

      if (!existing) {
        existing = { type: 'folder', name: folderName, fullPath: folderPath, children: [], projectCount: 0 };
        currentLevel.push(existing);
      }

      currentLevel = existing.children;
    }

    currentLevel.push({ type: 'project', project });
  }

  const countAndSort = (nodes: TreeNode[]): number => {
    let total = 0;
    for (const node of nodes) {
      if (node.type === 'folder') {
        node.projectCount = countAndSort(node.children);
        total += node.projectCount;
      } else {
        total += 1;
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      const nameA = a.type === 'folder' ? a.name : a.project.name;
      const nameB = b.type === 'folder' ? b.name : b.project.name;
      return nameA.localeCompare(nameB);
    });
    return total;
  };

  countAndSort(tree);
  return tree;
}

function buildMultiRootTree(projects: Project[], roots: string[]): TreeNode[] {
  const tree: TreeNode[] = [];

  for (const root of roots) {
    const rootProjects = projects.filter(p => p.path.startsWith(root));
    if (rootProjects.length === 0) continue;

    const rootName = root.split('/').pop() ?? root;
    const children = buildTree(rootProjects, root);

    tree.push({
      type: 'folder',
      name: rootName,
      fullPath: root,
      children,
      projectCount: rootProjects.length,
    });
  }

  return tree;
}

// --- Components ---

interface ProjectListProps {
  projects: Project[];
  instances: Instance[];
  loading: boolean;
  scanPaths: string[];
  selectedRoot: string | null;
  onLaunch: (projectPath: string, taskDescription?: string, branchName?: string) => void;
  onDeleteWorktree: (projectPath: string, worktreePath: string) => void;
}

export default function ProjectList({ projects, instances, loading, scanPaths, selectedRoot, onLaunch, onDeleteWorktree }: ProjectListProps) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchTarget, setLaunchTarget] = useState<Project | null>(null);

  const activeProjectPaths = useMemo(
    () => new Set(instances.filter(i => i.status !== 'exited').map(i => i.projectPath)),
    [instances],
  );

  const worktreesByParent = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of projects) {
      if (p.isWorktree && p.parentProject) {
        const list = map.get(p.parentProject) ?? [];
        list.push(p);
        map.set(p.parentProject, list);
      }
    }
    return map;
  }, [projects]);

  const regularProjects = useMemo(
    () => projects.filter(p => !(p.isWorktree && p.parentProject)),
    [projects],
  );

  const tree = useMemo(() => {
    if (selectedRoot) {
      return buildTree(regularProjects, selectedRoot);
    }
    return buildMultiRootTree(regularProjects, scanPaths);
  }, [regularProjects, scanPaths, selectedRoot]);

  const prevRootRef = useRef<string | null | undefined>(undefined);
  if (prevRootRef.current !== selectedRoot) {
    prevRootRef.current = selectedRoot;
    const firstLevel = new Set<string>();
    for (const node of tree) {
      if (node.type === 'folder') {
        firstLevel.add(node.fullPath);
      }
    }
    setExpanded(firstLevel);
  }

  const toggleFolder = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleProjectWorktrees = useCallback((path: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleLaunchFromModal = (projectPath: string, taskDescription?: string, branchName?: string) => {
    setLaunching(projectPath);
    onLaunch(projectPath, taskDescription, branchName);
    setTimeout(() => setLaunching(null), 1000);
  };

  const handleDirectLaunch = useCallback((projectPath: string) => {
    setLaunching(projectPath);
    onLaunch(projectPath);
    setTimeout(() => setLaunching(null), 1000);
  }, [onLaunch]);

  const filtered = useMemo(() => {
    if (!filter) return null;
    return projects.filter(p =>
      p.name.toLowerCase().includes(filter.toLowerCase()) ||
      p.path.toLowerCase().includes(filter.toLowerCase()) ||
      (p.gitBranch?.toLowerCase().includes(filter.toLowerCase()) ?? false),
    );
  }, [projects, filter]);

  return (
    <div className="flex flex-col gap-1">
      {/* Search — subtle, borderless */}
      <div className="relative px-1">
        <Search className="absolute left-3 top-2 h-3.5 w-3.5 text-faint" />
        <input
          type="text"
          placeholder="Search..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full rounded bg-transparent py-1.5 pl-7 pr-3 text-[12px] text-tertiary placeholder-placeholder outline-none transition-colors focus:bg-surface/50"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-faint">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : filtered ? (
        filtered.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-faint">No projects match</p>
        ) : (
          <div className="flex flex-col">
            {filtered.map(project => {
              const isNestedWt = project.isWorktree && !!project.parentProject;
              return (
                <ProjectRow
                  key={project.path}
                  project={project}
                  worktrees={[]}
                  isProjectExpanded={false}
                  isActive={activeProjectPaths.has(project.path)}
                  isLaunching={launching === project.path}
                  launching={launching}
                  depth={0}
                  onLaunch={isNestedWt ? () => handleDirectLaunch(project.path) : () => setLaunchTarget(project)}
                  onToggleWorktrees={() => {}}
                  onLaunchDirect={handleDirectLaunch}
                  onDeleteWorktree={onDeleteWorktree}
                />
              );
            })}
          </div>
        )
      ) : tree.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-faint">No projects found</p>
      ) : (
        <div className="flex flex-col">
          <TreeNodeList
            nodes={tree}
            depth={0}
            expanded={expanded}
            expandedProjects={expandedProjects}
            activeProjectPaths={activeProjectPaths}
            launching={launching}
            worktreesByParent={worktreesByParent}
            onToggle={toggleFolder}
            onToggleProjectWorktrees={toggleProjectWorktrees}
            onLaunchModal={setLaunchTarget}
            onLaunchDirect={handleDirectLaunch}
            onDeleteWorktree={onDeleteWorktree}
          />
        </div>
      )}

      {launchTarget && (
        <LaunchModal
          project={launchTarget}
          onLaunch={handleLaunchFromModal}
          onClose={() => setLaunchTarget(null)}
        />
      )}
    </div>
  );
}

// --- Tree rendering ---

interface TreeProps {
  expanded: Set<string>;
  expandedProjects: Set<string>;
  activeProjectPaths: Set<string>;
  launching: string | null;
  worktreesByParent: Map<string, Project[]>;
  onToggle: (path: string) => void;
  onToggleProjectWorktrees: (path: string) => void;
  onLaunchModal: (project: Project) => void;
  onLaunchDirect: (path: string) => void;
  onDeleteWorktree: (projectPath: string, worktreePath: string) => void;
}

function TreeNodeList({
  nodes,
  depth,
  ...treeProps
}: { nodes: TreeNode[]; depth: number } & TreeProps) {
  const { expanded, expandedProjects, activeProjectPaths, launching, worktreesByParent, onToggle, onToggleProjectWorktrees, onLaunchModal, onLaunchDirect, onDeleteWorktree } = treeProps;

  return (
    <>
      {nodes.map(node => {
        if (node.type === 'folder') {
          return (
            <FolderRow
              key={node.fullPath}
              node={node}
              depth={depth}
              isExpanded={expanded.has(node.fullPath)}
              {...treeProps}
            />
          );
        }

        const worktrees = worktreesByParent.get(node.project.path) ?? [];
        return (
          <ProjectRow
            key={node.project.path}
            project={node.project}
            worktrees={worktrees}
            isProjectExpanded={expandedProjects.has(node.project.path)}
            isActive={activeProjectPaths.has(node.project.path)}
            isLaunching={launching === node.project.path}
            launching={launching}
            depth={depth}
            onLaunch={() => onLaunchModal(node.project)}
            onToggleWorktrees={() => onToggleProjectWorktrees(node.project.path)}
            onLaunchDirect={onLaunchDirect}
            onDeleteWorktree={onDeleteWorktree}
          />
        );
      })}
    </>
  );
}

function FolderRow({
  node,
  depth,
  isExpanded,
  ...treeProps
}: { node: FolderTreeNode; depth: number; isExpanded: boolean } & TreeProps) {
  return (
    <>
      <button
        onClick={() => treeProps.onToggle(node.fullPath)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-elevated/30"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-faint" />
        )}
        <Folder className={`h-3.5 w-3.5 shrink-0 ${isExpanded ? 'text-tertiary' : 'text-muted'}`} />
        <span className="truncate text-[13px] text-tertiary">{node.name}</span>
      </button>

      {isExpanded && (
        <TreeNodeList
          nodes={node.children}
          depth={depth + 1}
          {...treeProps}
        />
      )}
    </>
  );
}

// --- Project row ---

function ProjectRow({
  project,
  worktrees,
  isProjectExpanded,
  isActive,
  isLaunching,
  launching,
  depth,
  onLaunch,
  onToggleWorktrees,
  onLaunchDirect,
  onDeleteWorktree,
}: {
  project: Project;
  worktrees: Project[];
  isProjectExpanded: boolean;
  isActive: boolean;
  isLaunching: boolean;
  launching: string | null;
  depth: number;
  onLaunch: () => void;
  onToggleWorktrees: () => void;
  onLaunchDirect: (path: string) => void;
  onDeleteWorktree: (projectPath: string, worktreePath: string) => void;
}) {
  const hasWorktrees = worktrees.length > 0;

  return (
    <>
      <div
        className={`group flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-elevated/30 ${
          isActive ? 'bg-blue-500/8' : ''
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasWorktrees ? (
          <button
            onClick={e => { e.stopPropagation(); onToggleWorktrees(); }}
            className="shrink-0 text-faint hover:text-tertiary"
          >
            {isProjectExpanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate text-[13px] ${isActive ? 'text-primary' : 'text-tertiary'}`}>
              {project.name}
            </span>
            {project.hasClaudeMd && (
              <span title="Has CLAUDE.md"><FileText className="h-3 w-3 shrink-0 text-faint" /></span>
            )}
            {project.isWorktree && (
              <span className="shrink-0 text-[10px] text-faint">wt</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {project.isWorktree && project.parentProject && (
            <button
              onClick={e => {
                e.stopPropagation();
                onDeleteWorktree(project.parentProject!, project.path);
              }}
              className="shrink-0 rounded p-1 text-faint opacity-0 transition-all hover:text-red-400 group-hover:opacity-100"
              title="Delete worktree"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={onLaunch}
            disabled={isLaunching}
            className="shrink-0 rounded p-1 text-faint opacity-0 transition-all hover:text-secondary group-hover:opacity-100 disabled:opacity-50"
            title="Launch Claude Code"
          >
            {isLaunching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {isProjectExpanded && worktrees.map(wt => (
        <WorktreeRow
          key={wt.path}
          worktree={wt}
          depth={depth + 1}
          isLaunching={launching === wt.path}
          onLaunch={() => onLaunchDirect(wt.path)}
          onDelete={() => onDeleteWorktree(wt.parentProject!, wt.path)}
        />
      ))}
    </>
  );
}

// --- Worktree sub-row ---

function WorktreeRow({
  worktree,
  depth,
  isLaunching,
  onLaunch,
  onDelete,
}: {
  worktree: Project;
  depth: number;
  isLaunching: boolean;
  onLaunch: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-elevated/30"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <GitBranch className="h-3 w-3 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
        {worktree.gitBranch ?? worktree.name}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
      </div>
    </div>
  );
}
