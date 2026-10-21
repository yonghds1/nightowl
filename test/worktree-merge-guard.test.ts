import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

function commit(msg: string, file: string, content: string, cwd: string = root): void {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
  git(['add', file], cwd);
  git(['commit', '-q', '-m', msg], cwd);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-wt-guard-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  commit('initial commit', 'init.txt', 'base');

  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function readyWorktree(id: string): string {
  runCommand(createWorktreeCommand(), ['setup', id]);
  return path.join(root, '.nightowl', 'worktrees', id);
}

describe('worktree merge 前置守卫', () => {
  it('已跟踪文件有未提交改动 → WORKTREE_MERGE_DIRTY,不尝试合并', () => {
    const wt = readyWorktree('T1');
    commit('[#T1] implement', 'impl.txt', 'work', wt);
    // 已跟踪文件被改但未提交(未跟踪文件不参与合并,不拦)
    fs.writeFileSync(path.join(root, 'init.txt'), 'local edit not committed', 'utf8');

    const r = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('WORKTREE_MERGE_DIRTY');
    // 没有产生合并提交
    expect(git(['log', '--oneline', '-1']).stdout).not.toContain('merge: [#T1]');
  });

  it('只有未跟踪文件(如 init 铺入的技能)→ 不阻断合并', () => {
    const wt = readyWorktree('T1');
    commit('[#T1] implement', 'impl.txt', 'work', wt);
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'note.md'), 'untracked', 'utf8');

    const r = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('WORKTREE_MERGED');
  });

  it('detached HEAD → WORKTREE_DETACHED,避免游离提交', () => {
    const wt = readyWorktree('T1');
    commit('[#T1] implement', 'impl.txt', 'work', wt);
    expect(git(['checkout', '-q', '--detach']).status).toBe(0);

    const r = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('WORKTREE_DETACHED');
  });

  it('存在未完成 merge → WORKTREE_MERGE_IN_PROGRESS', () => {
    const wt = readyWorktree('T1');
    commit('[#T1] implement', 'impl.txt', 'work', wt);
    const head = git(['rev-parse', 'HEAD']).stdout;
    fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), `${head}\n`, 'utf8');

    const r = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('WORKTREE_MERGE_IN_PROGRESS');
  });

  it('冲突 → WORKTREE_MERGE_CONFLICT 并自动 abort,主分支保持合并前内容', () => {
    const wt = readyWorktree('T1');
    // 分支侧与主分支侧改同一行 → 必然冲突
    commit('[#T1] branch side', 'init.txt', 'branch side', wt);
    commit('main side', 'init.txt', 'main side');

    const r = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('WORKTREE_MERGE_CONFLICT');

    // 冲突已被回滚:没有 MERGE_HEAD,文件回到主分支版本
    expect(git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']).status).not.toBe(0);
    expect(fs.readFileSync(path.join(root, 'init.txt'), 'utf8')).toBe('main side');
    expect(git(['status', '--porcelain']).stdout).toBe('');
  });
});
