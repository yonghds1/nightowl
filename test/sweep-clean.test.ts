import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createSweepCommand } from '../src/commands/sweep.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

/**
 * sweep --clean:真正清理残留 worktree。
 *
 * E2E 暴露:run.md 写"sweep 清残留 worktree",但 sweep 实际只报告不删,
 * agent 读到文档后只能自己 rm -rf 手动清理 —— 清理动作绕过了所有安全检查。
 * 现在把"安全清理"收进 CLI:只有"无未合入 commit"且"无未提交改动"才删。
 */

let root: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-sc-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function wtPath(id: string): string {
  return path.join(root, '.nightowl', 'worktrees', id);
}

function addTask(id: string): void {
  runCommand(createAddCommand(), [
    '--id', id, '--title', `t ${id}`, '--priority', 'P0', '--est-min', '5',
  ]);
}

/** 建 worktree 并在里面提交(不合并)。 */
function setupWithCommit(id: string): string {
  addTask(id);
  runCommand(createWorktreeCommand(), ['setup', id]);
  fs.writeFileSync(path.join(wtPath(id), 'impl.txt'), id, 'utf8');
  git(['add', 'impl.txt'], wtPath(id));
  git(['commit', '-qm', `[#${id}] impl`], wtPath(id));
  return wtPath(id);
}

describe('sweep 默认只报告,不动现场', () => {
  it('无残留 → SWEEP_CLEAN', () => {
    expect(runCommand(createSweepCommand(), []).stdout).toContain('SWEEP_CLEAN');
  });

  it('有残留 → 报告但保留目录', () => {
    const wt = setupWithCommit('T1');
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).toContain('nightowl/T1');
    expect(fs.existsSync(wt)).toBe(true);
  });
});

describe('sweep --clean 安全边界', () => {
  it('未合入的 worktree 保留(SWEEP_KEEP_UNMERGED)', () => {
    const wt = setupWithCommit('T1');
    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_KEEP_UNMERGED');
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('未提交改动的 worktree 保留(SWEEP_KEEP_DIRTY)', () => {
    // 先合并进去再制造脏改动
    const wt = setupWithCommit('T2');
    git(['merge', '-q', '--no-ff', '-m', 'merge [#T2]', 'nightowl/T2']);
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'uncommitted', 'utf8');

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_KEEP_DIRTY');
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('已合入且干净 → 真正删除(SWEEP_REMOVED)', () => {
    const wt = setupWithCommit('T3');
    git(['merge', '-q', '--no-ff', '-m', 'merge [#T3]', 'nightowl/T3']);

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_REMOVED');
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(['branch', '--list', 'nightowl/T3'])).toBe('');
  });

  it('清理后再次 sweep → SWEEP_CLEAN', () => {
    const wt = setupWithCommit('T4');
    git(['merge', '-q', '--no-ff', '-m', 'merge [#T4]', 'nightowl/T4']);
    runCommand(createSweepCommand(), ['--clean']);
    expect(fs.existsSync(wt)).toBe(false);
    expect(runCommand(createSweepCommand(), ['--clean']).stdout).toContain('SWEEP_CLEAN');
  });

  it('混合场景:只删安全的那一个', () => {
    const safe = setupWithCommit('T5');
    git(['merge', '-q', '--no-ff', '-m', 'merge [#T5]', 'nightowl/T5']);
    const unsafe = setupWithCommit('T6'); // 未合入

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_REMOVED');
    expect(fs.existsSync(safe)).toBe(false);
    expect(fs.existsSync(unsafe)).toBe(true);
  });
});
