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

function git(args: string[], cwd: string = root): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.stdout.trim();
}

function commit(msg: string, file: string, cwd: string = root): void {
  fs.writeFileSync(path.join(cwd, file), `${msg} @ ${file}`);
  git(['add', file], cwd);
  git(['commit', '-q', '-m', msg], cwd);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-wt-test-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  commit('initial commit', 'init.txt');

  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  process.chdir(prevCwd);
  // 清理临时仓库
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nightowl worktree 命令簇', () => {
  it('setup 为指定任务创建独立隔离工作树与分支', () => {
    const r = runCommand(createWorktreeCommand(), ['setup', 'T1']);
    expect(r.output).toContain('WORKTREE_READY');
    expect(r.output).toContain('branch: nightowl/T1');

    const wtDir = path.join(root, '.nightowl', 'worktrees', 'T1');
    expect(fs.existsSync(wtDir)).toBe(true);

    // 重复 setup 应报告已存在
    const r2 = runCommand(createWorktreeCommand(), ['setup', 'T1']);
    expect(r2.output).toContain('WORKTREE_EXISTS');
  });

  it('merge 能够校验 commit 标记并成功合入当前主分支', () => {
    // 1. 创建工作树
    runCommand(createWorktreeCommand(), ['setup', 'T2']);
    const wtDir = path.join(root, '.nightowl', 'worktrees', 'T2');

    // 2. 模拟在工作树中完成编码与提交
    commit('[#T2] implement feature two', 'feature.txt', wtDir);

    // 3. 执行 merge
    const r = runCommand(createWorktreeCommand(), ['merge', 'T2']);
    expect(r.output).toContain('WORKTREE_MERGED: nightowl/T2');

    // 4. 验证主分支已拥有该文件与提交
    expect(fs.existsSync(path.join(root, 'feature.txt'))).toBe(true);
    const log = git(['log', '-1', '--oneline']);
    expect(log).toContain('merge: [#T2]');
  });

  it('merge 在缺少 [#id] 标记时阻断', () => {
    runCommand(createWorktreeCommand(), ['setup', 'T3']);
    const wtDir = path.join(root, '.nightowl', 'worktrees', 'T3');

    // 提交漏带 [#T3]
    commit('feature three without tag', 'feat3.txt', wtDir);

    const r = runCommand(createWorktreeCommand(), ['merge', 'T3']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('has no commit tagged [#T3]');
  });

  it('list 与 cleanup 生命周期完整性', () => {
    // 初始状态下 list 为空
    const rEmpty = runCommand(createWorktreeCommand(), ['list']);
    expect(rEmpty.output).toContain('WORKTREE_EMPTY');

    // 创建两个任务工作树
    runCommand(createWorktreeCommand(), ['setup', 'TASK-A']);
    runCommand(createWorktreeCommand(), ['setup', 'TASK-B']);

    const rList = runCommand(createWorktreeCommand(), ['list']);
    expect(rList.output).toContain('TASK-A\tnightowl/TASK-A');
    expect(rList.output).toContain('TASK-B\tnightowl/TASK-B');

    // 清理 TASK-A
    const rCleanA = runCommand(createWorktreeCommand(), ['cleanup', 'TASK-A']);
    expect(rCleanA.output).toContain('WORKTREE_CLEANED: TASK-A');

    // 验证 TASK-A 的工作树目录和分支都已被删除
    const wtA = path.join(root, '.nightowl', 'worktrees', 'TASK-A');
    expect(fs.existsSync(wtA)).toBe(false);
    expect(git(['branch', '--list', 'nightowl/TASK-A'])).toBe('');

    // TASK-B 依然存在
    const rListAfter = runCommand(createWorktreeCommand(), ['list']);
    expect(rListAfter.output).not.toContain('TASK-A');
    expect(rListAfter.output).toContain('TASK-B');

    // 清理 TASK-B
    runCommand(createWorktreeCommand(), ['cleanup', 'TASK-B']);
    const rFinal = runCommand(createWorktreeCommand(), ['list']);
    expect(rFinal.output).toContain('WORKTREE_EMPTY');
  });
});
