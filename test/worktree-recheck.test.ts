import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPool } from '../src/state.js';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

function commit(msg: string, file: string, cwd: string = root): void {
  fs.writeFileSync(path.join(cwd, file), msg, 'utf8');
  git(['add', file], cwd);
  git(['commit', '-q', '-m', msg], cwd);
}

function wtPath(id: string): string {
  return path.join(root, '.nightowl', 'worktrees', id);
}

function addTaskWithVerify(id: string, verify: string): void {
  runCommand(createAddCommand(), [
    '--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '15',
    '--verify', verify,
  ]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-recheck-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  commit('initial', 'init.txt');

  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('worktree merge 的合并后复验', () => {
  it('隔离区通过、合并后失败 → WORKTREE_MERGE_RECHECK_FAIL 并回滚主分支', () => {
    // 该门禁在 worktree 里成立,但主分支上不成立 → 只有"合并后复验"能发现
    addTaskWithVerify('T1', 'test ! -f main-only.txt');
    runCommand(createWorktreeCommand(), ['setup', 'T1']);
    commit('[#T1] implement', 'impl.txt', wtPath('T1'));

    const v = runCommand(createVerifyCommand(), ['T1']);
    expect(v.stdout).toContain('ALL_PASS');

    // 验证之后主分支前进(与实现无关的改动),worktree 里看不到
    commit('main only change', 'main-only.txt');
    const beforeHead = git(['rev-parse', 'HEAD']).stdout;

    const m = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(m.exitCode).toBe(1);
    expect(m.output).toContain('WORKTREE_MERGE_RECHECK_FAIL');
    expect(git(['rev-parse', 'HEAD']).stdout).toBe(beforeHead);
    expect(git(['log', '-1', '--format=%s']).stdout).toBe('main only change');
    // 任务分支与 worktree 现场保留,便于修复后重试
    expect(git(['branch', '--list', 'nightowl/T1']).stdout).toContain('nightowl/T1');
    expect(fs.existsSync(path.join(wtPath('T1'), 'impl.txt'))).toBe(true);
    expect(loadPool()!.pool[0].verify_passed).toBeUndefined();
    expect(loadPool()!.pool[0].verification_run?.status).toBe('failed');
    const retry = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(retry.exitCode).toBe(1);
    expect(retry.output).toContain('VERIFY_RECORD_STALE:');
  });

  it('合并后仍通过 → WORKTREE_MERGED,主分支拿到合并提交', () => {
    addTaskWithVerify('T2', 'test -f impl2.txt');
    runCommand(createWorktreeCommand(), ['setup', 'T2']);
    commit('[#T2] implement', 'impl2.txt', wtPath('T2'));
    expect(runCommand(createVerifyCommand(), ['T2']).stdout).toContain('ALL_PASS');

    const m = runCommand(createWorktreeCommand(), ['merge', 'T2']);
    expect(m.exitCode).toBeUndefined();
    expect(m.stdout).toContain('WORKTREE_MERGED');
    expect(fs.existsSync(path.join(root, 'impl2.txt'))).toBe(true);
    expect(git(['log', '-1', '--format=%s']).stdout).toContain('[#T2]');
  });

  it('--no-recheck 可跳过合并后复验(逃生口)', () => {
    addTaskWithVerify('T3', 'test ! -f blocked.txt');
    runCommand(createWorktreeCommand(), ['setup', 'T3']);
    commit('[#T3] implement', 'impl3.txt', wtPath('T3'));
    expect(runCommand(createVerifyCommand(), ['T3']).stdout).toContain('ALL_PASS');

    commit('root change', 'blocked.txt');
    const m = runCommand(createWorktreeCommand(), ['merge', 'T3', '--no-recheck']);
    expect(m.exitCode).toBeUndefined();
    expect(m.stdout).toContain('WORKTREE_MERGED');
  });
});
