import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createReviewCommand } from '../src/commands/review.js';
import { createDoneCommand } from '../src/commands/done.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { createSweepCommand } from '../src/commands/sweep.js';
import { createPushCommand } from '../src/commands/push.js';
import { runCommand } from './helpers.js';

// 非 git 根目录(多仓父目录/普通目录)降级:
// workspaceOffline 实景 —— 根目录无 .git,任务实现在子仓库。夜隔离类命令(worktree/sweep/push)
// 必须优雅降级而不是 SWEEP_FAIL exit 1 / WORKTREE_SETUP_FAIL 卡死调度循环;
// done 的 commit 门禁也不得对无 git 环境误报 noCommit。

let root: string;
let prevCwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-nogit-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  // 刻意不 git init —— 这就是被测环境本身
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function addTask(id: string): void {
  const r = runCommand(createAddCommand(), [
    '--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '15',
    '--verify', 'true',
  ]);
  expect(r.exitCode).toBeUndefined();
}

describe('非 git 根目录降级', () => {
  it('worktree setup → WORKTREE_SKIPPED,不建目录不 exit', () => {
    addTask('T1');
    const r = runCommand(createWorktreeCommand(), ['setup', 'T1']);
    expect(r.output).toContain(`WORKTREE_SKIPPED: not a git repo, implement directly in ${root}`);
    expect(r.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(root, '.nightowl', 'worktrees'))).toBe(false);
  });

  it('worktree merge/cleanup/list → 各自 SKIPPED / EMPTY,exit 0', () => {
    expect(runCommand(createWorktreeCommand(), ['merge', 'T1']).output).toContain('WORKTREE_MERGE_SKIPPED:');
    expect(runCommand(createWorktreeCommand(), ['cleanup', 'T1']).output).toContain('WORKTREE_CLEAN_SKIPPED:');
    expect(runCommand(createWorktreeCommand(), ['list']).output).toContain('WORKTREE_EMPTY');
  });

  it('sweep --clean → SWEEP_CLEAN(干净语义,流程继续)', () => {
    expect(runCommand(createSweepCommand(), ['--clean']).output).toContain('SWEEP_CLEAN');
  });

  it('push → PUSH_SKIPPED_NO_GIT(子仓推送由任务命令自带)', () => {
    expect(runCommand(createPushCommand(), []).output).toContain('PUSH_SKIPPED_NO_GIT');
  });

  it('全链路:next→setup(降级)→verify→review→done 不误报 noCommit', () => {
    addTask('T1');
    expect(runCommand(createWorktreeCommand(), ['setup', 'T1']).output).toContain('WORKTREE_SKIPPED:');
    expect(runCommand(createVerifyCommand(), ['--id', 'T1']).output).toContain('ALL_PASS');
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    const r = runCommand(createDoneCommand(), ['T1']);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).not.toContain('noCommit');
  });

  it('混合场景:根无 git + 子仓有 git,nightowl 命令仍看根的判定', () => {
    // 子仓存在但根目录仍非 git:夜命令以调用 cwd 判定,不变
    const sub = path.join(root, 'sub-repo');
    fs.mkdirSync(sub);
    spawnSync('git', ['-C', sub, 'init', '-q'], { encoding: 'utf8' });
    spawnSync('git', ['-C', sub, 'config', 'user.email', 't@t.local'], { encoding: 'utf8' });
    spawnSync('git', ['-C', sub, 'config', 'user.name', 't'], { encoding: 'utf8' });

    expect(runCommand(createWorktreeCommand(), ['setup', 'T1']).output).toContain('WORKTREE_SKIPPED:');
    expect(runCommand(createSweepCommand(), ['--clean']).output).toContain('SWEEP_CLEAN');
  });
});
