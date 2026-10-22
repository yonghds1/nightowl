import fs from 'node:fs';
import path from 'node:path';
import { probeGit } from './git.js';

export const BUILD_FILES = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'setup.py',
];
export const DOC_FILES = ['README', 'readme', 'README.md', 'README.txt'];
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', 'venv', '__pycache__',
]);

export interface WorkspaceContext {
  root: string;
  kind: 'single-repo' | 'mixed' | 'plain';
  repositories: string[];
  projects: string[];
  errors: string[];
}

/** Read-only, bounded discovery. Never descend into repositories or directory symlinks. */
export function discoverWorkspace(
  cwd = process.cwd(),
  limits: { maxDepth?: number; maxDirectories?: number } = {},
): WorkspaceContext {
  const root = path.resolve(cwd);
  const context: WorkspaceContext = { root, kind: 'plain', repositories: [], projects: [], errors: [] };
  const maxDepth = limits.maxDepth ?? 4;
  const maxDirectories = limits.maxDirectories ?? 1000;
  let visited = 0;
  try {
    const repo = probeGit(root);
    if (repo.isRepo) {
      context.kind = 'single-repo';
      context.repositories.push(repo.root);
      context.projects.push(root);
      return context;
    }
  } catch (error: unknown) {
    context.errors.push(`${root}: ${(error as Error).message}`);
    return context;
  }

  function visit(dir: string, depth: number): void {
    if (++visited > maxDirectories) {
      if (!context.errors.some((message) => message.startsWith('directory limit'))) {
        context.errors.push(`directory limit (${maxDirectories}): ${dir}`);
      }
      return;
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      if (dir !== root && entries.some((entry) => entry.name === '.git')) {
        const repo = probeGit(dir);
        if (!repo.isRepo || path.resolve(repo.root) !== dir) throw new Error('invalid Git repository');
        context.repositories.push(dir);
        context.projects.push(dir);
        return;
      }
      if (depth === 1 || entries.some((entry) => entry.isFile() && [...BUILD_FILES, ...DOC_FILES].includes(entry.name))) {
        context.projects.push(dir);
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const child = path.join(dir, entry.name);
        if (depth >= maxDepth) {
          context.errors.push(`depth limit (${maxDepth}): ${child}`);
        } else if (visited >= maxDirectories) {
          context.errors.push(`directory limit (${maxDirectories}): ${child}`);
          break;
        } else {
          visit(child, depth + 1);
        }
      }
    } catch (error: unknown) {
      context.errors.push(`${dir}: ${(error as Error).message}`);
    }
  }
  visit(root, 0);
  context.repositories.sort();
  context.projects.sort();
  context.kind = context.repositories.length ? 'mixed' : 'plain';
  return context;
}
