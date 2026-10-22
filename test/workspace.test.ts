import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverWorkspace } from '../src/workspace.js';
import { probeGit } from '../src/git.js';

let root: string;
function repo(relative: string): string {
  const dir = path.join(root, relative);
  fs.mkdirSync(dir, { recursive: true });
  expect(spawnSync('git', ['init', '-q', dir]).status).toBe(0);
  return dir;
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-workspace-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('workspace discovery', () => {
  it('finds nested repositories, plain projects and direct ordinary directories in stable order', () => {
    repo('wrapper/repo b');
    repo('repo-a');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'package.json'), '{"scripts":{"test":"node check.js"}}');
    repo('node_modules/ignored');
    repo('.hidden/ignored');
    repo('repo-a/nested'); // A repository owns its implementation tree.
    const found = discoverWorkspace(root);
    expect(found.kind).toBe('mixed');
    expect(found.repositories.map((p) => path.relative(root, p))).toEqual(['repo-a', 'wrapper/repo b']);
    expect(found.projects).toContain(path.join(root, 'scripts'));
    expect(found.errors).toEqual([]);
  });

  it('does not follow directory symlinks or cycles', () => {
    fs.mkdirSync(path.join(root, 'plain'));
    fs.symlinkSync(root, path.join(root, 'plain', 'loop'));
    fs.symlinkSync('/tmp', path.join(root, 'outside'));
    expect(discoverWorkspace(root).errors).toEqual([]);
    expect(discoverWorkspace(root).kind).toBe('plain');
  });

  it('reports depth and directory limits instead of claiming discovery is complete', () => {
    repo('a/b/c');
    expect(discoverWorkspace(root, { maxDepth: 1 }).errors.join(' ')).toContain('limit');
    expect(discoverWorkspace(root, { maxDirectories: 1 }).errors.join(' ')).toContain('limit');
  });

  it('reports a damaged Git marker and missing directory as errors, not plain directories', () => {
    const broken = path.join(root, 'broken');
    fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
    expect(discoverWorkspace(root).errors.join(' ')).toContain('broken');
    expect(() => probeGit(broken)).toThrow();
    expect(discoverWorkspace(path.join(root, 'missing')).errors.length).toBeGreaterThan(0);
  });

  it('reports unreadable directories instead of silently skipping them', () => {
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0);
    try {
      expect(discoverWorkspace(root).errors.join(' ')).toContain('locked');
    } finally { fs.chmodSync(locked, 0o700); }
  });

  it('accepts linked worktrees with a .git file and a cwd inside a repository', () => {
    const main = repo('main');
    for (const args of [['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base']]) {
      expect(spawnSync('git', ['-C', main, ...args]).status).toBe(0);
    }
    const linked = path.join(root, 'linked');
    expect(spawnSync('git', ['-C', main, 'worktree', 'add', '-qb', 'linked', linked]).status).toBe(0);
    expect(discoverWorkspace(linked).kind).toBe('single-repo');
    fs.mkdirSync(path.join(main, 'src'));
    expect(discoverWorkspace(path.join(main, 'src')).kind).toBe('single-repo');
  });
});
