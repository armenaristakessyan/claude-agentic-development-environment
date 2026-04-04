import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}

export class WorktreeManager {
  isGitRepo(projectPath: string): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  slugify(text: string): string {
    // Take first 4 words max, then slugify to keep branch names short
    const words = text.trim().split(/\s+/).slice(0, 4).join(' ');
    return words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
  }

  createWorktree(projectPath: string, taskDescription: string): WorktreeResult {
    const slug = this.slugify(taskDescription);
    if (!slug) {
      throw new Error('Task description produced an empty slug');
    }

    const branchName = `claude/${slug}`;
    let worktreePath = `${projectPath}--${slug}`;

    // Collision handling: append -2, -3 if path exists
    let suffix = 1;
    while (fs.existsSync(worktreePath)) {
      suffix++;
      worktreePath = `${projectPath}--${slug}-${suffix}`;
    }

    const finalBranch = suffix > 1 ? `${branchName}-${suffix}` : branchName;

    console.log(`[worktree-manager] Creating worktree at ${worktreePath} (branch: ${finalBranch})`);

    execSync(`git worktree add -b "${finalBranch}" "${worktreePath}"`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });

    console.log(`[worktree-manager] Worktree created successfully`);

    return { worktreePath, branchName: finalBranch };
  }

  removeWorktree(projectPath: string, worktreePath: string): void {
    const branchName = this.getBranchName(worktreePath);

    console.log(`[worktree-manager] Removing worktree at ${worktreePath}`);

    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (err) {
      console.log(`[worktree-manager] Failed to remove worktree: ${err}`);
    }

    if (branchName) {
      try {
        execSync(`git branch -D "${branchName}"`, {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
        console.log(`[worktree-manager] Deleted branch ${branchName}`);
      } catch (err) {
        console.log(`[worktree-manager] Failed to delete branch ${branchName}: ${err}`);
      }
    }

    try {
      execSync('git worktree prune', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch (err) {
      console.log(`[worktree-manager] Failed to prune worktrees: ${err}`);
    }
  }

  isWorktree(projectPath: string): boolean {
    try {
      const gitPath = path.join(projectPath, '.git');
      return fs.statSync(gitPath).isFile();
    } catch {
      return false;
    }
  }

  getParentProjectPath(worktreePath: string): string | null {
    try {
      // In a worktree, .git is a file containing "gitdir: /path/to/main/.git/worktrees/<name>"
      const gitContent = fs.readFileSync(path.join(worktreePath, '.git'), 'utf-8').trim();
      const match = gitContent.match(/^gitdir:\s*(.+)$/);
      if (!match) return null;
      // Resolve: .git/worktrees/<name> → go up to the .git dir, then its parent is the main repo
      const gitdir = path.resolve(worktreePath, match[1]);
      const mainGitDir = path.resolve(gitdir, '..', '..');
      const mainRepoDir = path.dirname(mainGitDir);
      // Verify it's actually a git repo
      if (fs.statSync(mainGitDir).isDirectory()) {
        return mainRepoDir;
      }
      return null;
    } catch {
      return null;
    }
  }

  getGitBranch(projectPath: string): string | null {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      return branch || null;
    } catch {
      return null;
    }
  }

  private getBranchName(worktreePath: string): string | null {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      return branch || null;
    } catch {
      // Worktree may already be removed, try to infer from path
      const match = path.basename(worktreePath).match(/^.+--(.+)$/);
      if (match) {
        return `claude/${match[1]}`;
      }
      return null;
    }
  }
}
