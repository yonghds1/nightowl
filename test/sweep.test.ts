import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSweepCommand } from '../src/commands/sweep.js';
import { runCommand } from './helpers.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    .trimEnd();
}

let root: string;
let prevCwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-sweep-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  // sweep 的 git 命令继承进程 cwd,测试需切到临时仓库
  prevCwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sweep', () => {
  it('空仓库(无 commit)输出 SWEEP_CLEAN', () => {
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).toBe('SWEEP_CLEAN');
  });

  it('仅主 worktree 输出 SWEEP_CLEAN', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).toBe('SWEEP_CLEAN');
  });

  it('残留 worktree 输出 {branch}\\t{path}\\t{unmerged}', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);
    const wt = path.join(root, 'wt');
    git(root, ['worktree', 'add', wt, '-b', 'feat']);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'y');
    git(wt, ['add', '.']);
    git(wt, ['commit', '-m', 'feat: T1']);
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).not.toBe('SWEEP_CLEAN');
    const [branch, wtPath, unmerged] = r.stdout.split('\t');
    expect(branch).toBe('feat');
    expect(wtPath).toBe(wt);
    expect(unmerged).toBeTruthy();
  });

  it('已合入的 worktree 输出 unmerged 为空', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);
    const wt = path.join(root, 'wt');
    git(root, ['worktree', 'add', wt, '-b', 'feat']);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'y');
    git(wt, ['add', '.']);
    git(wt, ['commit', '-m', 'feat: T1']);
    git(root, ['merge', 'feat']);
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).not.toBe('SWEEP_CLEAN');
    const unmerged = r.stdout.split('\t')[2];
    expect(unmerged).toBe('');
  });
});
