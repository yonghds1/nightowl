import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createSweepCommand, mergeState, resolveBaseBranch } from '../src/commands/sweep.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

let root: string;
let baseBranch: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

function write(file: string, content: string, cwd: string = root): void {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
}

function commit(msg: string, file: string, content: string, cwd: string = root): void {
  write(file, content, cwd);
  git(['add', file], cwd);
  git(['commit', '-q', '-m', msg], cwd);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-sweep-merge-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  commit('initial', 'init.txt', 'base');
  baseBranch = git(['branch', '--show-current']).stdout;
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sweep 的“已合入”判定', () => {
  it('普通 merge 合入 → 祖先判定为已合入', () => {
    git(['checkout', '-q', '-b', 'feature']);
    commit('feature work', 'f.txt', '1');
    git(['checkout', '-q', baseBranch]);
    git(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);

    const s = mergeState('feature', baseBranch);
    expect(s.merged).toBe(true);
    expect(s.unmerged).toEqual([]);
  });

  it('未合入分支 → 列出未合入 commit,不误删', () => {
    git(['checkout', '-q', '-b', 'feature']);
    commit('feature work', 'f.txt', '1');
    git(['checkout', '-q', baseBranch]);

    const s = mergeState('feature', baseBranch);
    expect(s.merged).toBe(false);
    expect(s.unmerged).toHaveLength(1);
  });

  it('squash merge 后(非祖先但 patch 等价)→ 视为已合入', () => {
    git(['checkout', '-q', '-b', 'feature']);
    commit('feature work', 'f.txt', '1');
    git(['checkout', '-q', baseBranch]);
    git(['merge', '-q', '--squash', 'feature']);
    git(['commit', '-q', '-m', 'squash feature']);

    // 祖先判定为 false,但 patch-id 等价
    expect(git(['merge-base', '--is-ancestor', 'feature', 'HEAD']).status).not.toBe(0);
    expect(mergeState('feature', baseBranch).merged).toBe(true);
  });
});

describe('sweep 的集成分支解析', () => {
  it('显式 --base 优先', () => {
    expect(resolveBaseBranch('develop')).toBe('develop');
  });

  it('默认解析到本地集成分支,而不是当前 HEAD', () => {
    // 当前停在旧分支,主分支已经前进
    git(['branch', 'old']);
    commit('main moves on', 'm.txt', '1');
    git(['checkout', '-q', 'old']);

    expect(resolveBaseBranch()).toBe(baseBranch);
  });
});

describe('sweep --clean 的现场保护', () => {
  it('locked worktree 不删除', () => {
    runCommand(createWorktreeCommand(), ['setup', 'T1']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'T1');
    expect(git(['worktree', 'lock', wt]).status).toBe(0);

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_KEEP_LOCKED');
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('不在集成分支上跑 sweep,也不会把已合入的任务误判为未合入', () => {
    runCommand(createWorktreeCommand(), ['setup', 'T2']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'T2');
    commit('[#T2] implement', 'impl.txt', 'work', wt);
    runCommand(createWorktreeCommand(), ['merge', 'T2']);

    // 切到不含该合并的旧分支再清理
    git(['branch', 'old']);
    git(['checkout', '-q', 'old']);

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.output).toContain(`SWEEP_BASE: ${baseBranch}`);
    expect(r.stdout).toContain('SWEEP_REMOVED');
    expect(r.stdout).not.toContain('SWEEP_KEEP_UNMERGED');
    expect(fs.existsSync(wt)).toBe(false);
    // 已确认合入,分支应被删除(-d 失败后 -D 兜底)
    expect(git(['branch', '--list', 'nightowl/T2']).stdout).toBe('');
  });

  it('squash 合入后清理:worktree 与分支都回收', () => {
    runCommand(createWorktreeCommand(), ['setup', 'T3']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'T3');
    commit('[#T3] implement', 'impl3.txt', 'work', wt);

    git(['merge', '-q', '--squash', 'nightowl/T3']);
    git(['commit', '-q', '-m', 'squash [#T3]']);

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_REMOVED');
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(['branch', '--list', 'nightowl/T3']).stdout).toBe('');
  });
});
