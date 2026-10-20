import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { loadPool } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

/**
 * verify 回执必须绑定代码版本(head)。
 *
 * 实战暴露:E2E 里 OpenCode 平台跑出的 verify_passed 只有 {at, commands},
 * 没有 head —— 此时 worktree merge 的 VERIFY_RECORD_STALE 分支直接不生效,
 * "验证通过"变成不绑定任何代码的空头支票,改完代码照样能合并。
 */

let root: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
}

function verifyRecord(id: string) {
  const pool = loadPool()!;
  return pool.pool.find((t) => t.id === id)?.verify_passed;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-vhead-'));
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

function addTask(id: string, verify = 'true'): void {
  runCommand(createAddCommand(), [
    '--id', id, '--title', `t ${id}`, '--priority', 'P0', '--est-min', '5', '--verify', verify,
  ]);
}

describe('verify 回执绑定代码版本(head)', () => {
  it('主仓 verify → 记录当前 HEAD', () => {
    addTask('T1');
    runCommand(createVerifyCommand(), ['T1']);
    const rec = verifyRecord('T1')!;
    expect(rec.head).toBe(git(['rev-parse', 'HEAD']));
  });

  it('worktree 内 verify → 记录 worktree 分支的 HEAD(不是主仓 HEAD)', () => {
    addTask('T2');
    runCommand(createWorktreeCommand(), ['setup', 'T2']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'T2');
    fs.writeFileSync(path.join(wt, 'impl.txt'), 'work', 'utf8');
    spawnSync('git', ['-C', wt, 'add', 'impl.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-qm', '[#T2] impl'], { encoding: 'utf8' });

    runCommand(createVerifyCommand(), ['T2']);
    const rec = verifyRecord('T2')!;
    expect(rec.head).toBe(git(['rev-parse', 'nightowl/T2']));
    expect(rec.head).not.toBe(git(['rev-parse', 'HEAD']));
  });

  it('working tree 干净时 dirty_diff_hash = clean', () => {
    // 先把 .nightowl/ 提交掉,让工作区真的干净(否则 init/add 铺的文件本身就算 dirty)
    runCommand(createAddCommand(), [
      '--id', 'T3', '--title', 't', '--priority', 'P0', '--est-min', '5', '--verify', 'true',
    ]);
    git(['add', '-A']);
    git(['commit', '-qm', 'add T3']);
    runCommand(createVerifyCommand(), ['T3']);
    expect(verifyRecord('T3')!.dirty_diff_hash).toBe('clean');
  });

  it('working tree 有改动时 dirty_diff_hash 是哈希而非 clean', () => {
    addTask('T4');
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'uncommitted', 'utf8');
    runCommand(createVerifyCommand(), ['T4']);
    const h = verifyRecord('T4')!.dirty_diff_hash;
    expect(h).toBeTruthy();
    expect(h).not.toBe('clean');
  });

  it('回归:非 git 目录 verify 仍通过,但明确告警"回执未绑定版本"', () => {
    // 在无 git 的目录里建一个任务池
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-nogit-'));
    try {
      process.chdir(bare);
      setBaseDir(path.join(bare, '.nightowl'));
      runCommand(createInitCommand(), ['--skip-permissions']);
      runCommand(createAddCommand(), [
        '--id', 'T9', '--title', 't', '--priority', 'P0', '--est-min', '5', '--verify', 'true',
      ]);
      const r = runCommand(createVerifyCommand(), ['T9']);
      expect(r.stdout).toContain('ALL_PASS');
      // 关键:必须告警而不是静默放过
      expect(r.output).toMatch(/取不到|HEAD/);
      expect(verifyRecord('T9')!.head).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
