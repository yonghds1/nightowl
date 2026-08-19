import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createNextCommand } from '../src/commands/next.js';
import { createSweepCommand } from '../src/commands/sweep.js';
import { runCommand } from './helpers.js';

const ORIG_CWD = process.cwd();

let root: string;

function git(args: string[]) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-res-'));
  setBaseDir(path.join(root, '.nightowl'));
  process.chdir(root);
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'init');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  runCommand(createInitCommand(), ['--skip-permissions']);
  runCommand(createAddCommand(), [
    '--id', 'T1', '--title', 'Demo', '--priority', 'P0', '--est-min', '15',
  ]);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  fs.rmSync(root, { recursive: true, force: true });
});

/** 模拟子代理实现已 commit(含任务 id),未合并回原分支。只 add 实现文件,避免把 .nightowl 拖进 git。 */
function makeUnmergedCommit(): string {
  const base = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  git(['checkout', '-q', '-b', 'wt-t1']);
  fs.writeFileSync(path.join(root, 'impl.txt'), 'work');
  git(['add', 'impl.txt']);
  git(['commit', '-q', '-m', 'feat(T1): impl']);
  const h = git(['rev-parse', 'HEAD']).stdout.trim().slice(0, 7);
  git(['checkout', '-q', base]);
  return h;
}

/** 模拟 isolation=worktree 的真实残留:独立 worktree 目录里 commit,未合并回主分支。 */
function makeUnmergedWorktree(): string {
  const wt = path.join(root, 'wt');
  git(['worktree', 'add', '-q', '-b', 'wt-t1', wt]);
  fs.writeFileSync(path.join(wt, 'impl.txt'), 'work');
  spawnSync('git', ['-C', wt, 'add', 'impl.txt'], { encoding: 'utf8' });
  spawnSync('git', ['-C', wt, 'commit', '-q', '-m', 'feat(T1): impl'], { encoding: 'utf8' });
  return wt;
}

describe('续跑幂等(next 检测 RESUME)', () => {
  it('无 commit → RESUME in_progress(不重复实现)', () => {
    runCommand(createNextCommand(), []);
    const r = runCommand(createNextCommand(), []);
    expect(r.stdout).toContain('# RESUME in_progress T1');
    expect(r.stdout).not.toContain('RESUME_MERGE');
    expect(r.stdout).not.toContain('RESUME_COMMITTED');
  });

  it('未合入 commit → RESUME_MERGE', () => {
    runCommand(createNextCommand(), []);
    const h = makeUnmergedCommit();
    const r = runCommand(createNextCommand(), []);
    expect(r.stdout).toContain(`# RESUME_MERGE T1 ${h}`);
  });

  it('已合入当前分支 → RESUME_COMMITTED', () => {
    runCommand(createNextCommand(), []);
    makeUnmergedCommit();
    git(['merge', '-q', '--no-ff', '-m', 'merge T1', 'wt-t1']);
    const r = runCommand(createNextCommand(), []);
    expect(r.stdout).toContain('# RESUME_COMMITTED T1');
  });
});

describe('sweep 清理残留 worktree', () => {
  it('无 worktree → SWEEP_CLEAN', () => {
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).toContain('SWEEP_CLEAN');
  });

  it('报告未合入 commit 的 worktree', () => {
    makeUnmergedWorktree();
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).not.toContain('SWEEP_CLEAN');
    const line = r.stdout.split('\n').find((l) => l.startsWith('wt-t1'))!;
    const parts = line.split('\t');
    expect(parts[0]).toBe('wt-t1');
    expect(parts[2]).not.toBe(''); // 应有未合入 commit hash
  });

  it('合并后不再报告未合入 commit', () => {
    makeUnmergedWorktree();
    git(['merge', '-q', '--no-ff', '-m', 'merge T1', 'wt-t1']);
    const r = runCommand(createSweepCommand(), []);
    const line = r.stdout.split('\n').find((l) => l.startsWith('wt-t1'));
    if (line) {
      expect(line.split('\t')[2]).toBe('');
    } else {
      expect(r.stdout).toContain('SWEEP_CLEAN');
    }
  });

  it('报告 detached worktree 的未合入 commit', () => {
    const wt = path.join(root, 'wtdet');
    git(['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
    fs.writeFileSync(path.join(wt, 'det.txt'), 'x');
    spawnSync('git', ['-C', wt, 'add', 'det.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', 'feat(T1): detached work'], {
      encoding: 'utf8',
    });
    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).not.toContain('SWEEP_CLEAN');
    const line = r.stdout.split('\n').find((l) => l.includes(wt))!;
    const parts = line.split('\t');
    expect(parts[0]).not.toBe(''); // detached 列应为 commit hash
    expect(parts[2]).not.toBe(''); // 未合入 commit 应被报告
  });
});
