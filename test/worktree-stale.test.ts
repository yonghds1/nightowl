import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
}

function commit(msg: string, file: string, cwd: string = root): void {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`, 'utf8');
  git(['add', file], cwd);
  git(['commit', '-q', '-m', msg], cwd);
}

function wtPath(id: string): string {
  return path.join(root, '.nightowl', 'worktrees', id);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-stale-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));

  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 't']);
  commit('initial', 'init.txt');

  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function addTaskWithVerify(id: string): void {
  runCommand(createAddCommand(), [
    '--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '15',
    '--verify', 'true',
  ]);
}

/**
 * 验证回执强校验:verify 记录的 head 与 worktree 分支当前 HEAD 不一致时拒绝合并。
 * 这是整个产品最有价值的一道门 —— 它防的是"验证通过之后再偷偷改代码",
 * 光有 review/verify 状态字段是防不住的。
 */
describe('worktree merge 的验证回执强校验(防验证后偷改代码)', () => {
  it('验证后代码未变动 → WORKTREE_MERGED', () => {
    addTaskWithVerify('T1');
    runCommand(createWorktreeCommand(), ['setup', 'T1']);
    commit('[#T1] implement', 'impl.txt', wtPath('T1'));

    const v = runCommand(createVerifyCommand(), ['T1']);
    expect(v.stdout).toContain('ALL_PASS');

    const m = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(m.exitCode).toBeUndefined();
    expect(m.stdout).toContain('WORKTREE_MERGED: nightowl/T1');
    expect(fs.existsSync(path.join(root, 'impl.txt'))).toBe(true);
  });

  it('验证后又提交一次 → VERIFY_RECORD_STALE 且阻断合并', () => {
    addTaskWithVerify('T2');
    runCommand(createWorktreeCommand(), ['setup', 'T2']);
    commit('[#T2] implement', 'impl.txt', wtPath('T2'));
    runCommand(createVerifyCommand(), ['T2']);

    // 验证已过,validator 走人后再改一次代码
    commit('[#T2] sneaky tweak after verify', 'sneak.txt', wtPath('T2'));

    const m = runCommand(createWorktreeCommand(), ['merge', 'T2']);
    expect(m.exitCode).toBe(1);
    expect(m.output).toContain('VERIFY_RECORD_STALE');
    // 主分支不该拿到任何实现文件
    expect(fs.existsSync(path.join(root, 'impl.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'sneak.txt'))).toBe(false);
  });

  it('重新 verify 刷新回执后合并放行', () => {
    addTaskWithVerify('T3');
    runCommand(createWorktreeCommand(), ['setup', 'T3']);
    commit('[#T3] implement', 'impl.txt', wtPath('T3'));
    runCommand(createVerifyCommand(), ['T3']);
    commit('[#T3] tweak', 'sneak.txt', wtPath('T3'));

    expect(runCommand(createWorktreeCommand(), ['merge', 'T3']).exitCode).toBe(1);

    const v2 = runCommand(createVerifyCommand(), ['T3']);
    expect(v2.stdout).toContain('ALL_PASS');

    const m2 = runCommand(createWorktreeCommand(), ['merge', 'T3']);
    expect(m2.exitCode).toBeUndefined();
    expect(m2.stdout).toContain('WORKTREE_MERGED');
  });

  it('任务没有 verify 命令时不触发强校验(不误伤)', () => {
    runCommand(createAddCommand(), [
      '--id', 'T4', '--title', 'no verify', '--priority', 'P2', '--est-min', '10',
    ]);
    runCommand(createWorktreeCommand(), ['setup', 'T4']);
    commit('[#T4] implement', 'impl4.txt', wtPath('T4'));
    commit('[#T4] tweak', 'sneak4.txt', wtPath('T4'));

    const m = runCommand(createWorktreeCommand(), ['merge', 'T4']);
    expect(m.exitCode).toBeUndefined();
    expect(m.stdout).toContain('WORKTREE_MERGED');
  });
});

describe('worktree cleanup 的现场保护', () => {
  it('有未提交改动 → WORKTREE_DIRTY 且保留现场', () => {
    addTaskWithVerify('T5');
    runCommand(createWorktreeCommand(), ['setup', 'T5']);
    fs.writeFileSync(path.join(wtPath('T5'), 'wip.txt'), 'uncommitted work', 'utf8');

    const r = runCommand(createWorktreeCommand(), ['cleanup', 'T5']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('WORKTREE_DIRTY');
    expect(fs.existsSync(wtPath('T5'))).toBe(true);
    expect(fs.existsSync(path.join(wtPath('T5'), 'wip.txt'))).toBe(true);
  });

  it('--discard 才真正清掉未提交现场', () => {
    addTaskWithVerify('T6');
    runCommand(createWorktreeCommand(), ['setup', 'T6']);
    fs.writeFileSync(path.join(wtPath('T6'), 'wip.txt'), 'uncommitted work', 'utf8');

    const r = runCommand(createWorktreeCommand(), ['cleanup', 'T6', '--discard']);
    expect(r.stdout).toContain('WORKTREE_CLEANED: T6');
    expect(fs.existsSync(wtPath('T6'))).toBe(false);
  });
});
