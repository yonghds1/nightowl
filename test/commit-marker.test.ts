import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { taskCommitInHead, taskCommitStatus } from '../src/commands/next.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createReviewCommand } from '../src/commands/review.js';
import { createDoneCommand } from '../src/commands/done.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;

// git 在指定目录跑
function git(args: string[]): string {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();
}
function commit(msg: string, file: string): void {
  fs.writeFileSync(path.join(root, file), `${msg} @ ${file}`);
  git(['add', file]);
  git(['commit', '-q', '-m', msg]);
}
function setPlatform(id: string): void {
  fs.writeFileSync(path.join(root, '.nightowl', '.platform'), `${id}\n`, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-marker-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 't']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  // done 的 taskCommitInHead 跑在 process.cwd();nightowl 靠 preAction chdir 到项目根,测试同样 chdir。
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  runCommand(createInitCommand(), ['--skip-permissions']);
  runCommand(createAddCommand(), ['--id', 'T1', '--title', 'one', '--priority', 'P0', '--est-min', '15']);
  runCommand(createAddCommand(), ['--id', 'T10', '--title', 'ten', '--priority', 'P0', '--est-min', '15']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#1 [#id] 标记精确匹配(修 T1/T10 子串 bug)', () => {
  it('T1 的 commit 不被 T10 命中,反之亦然', () => {
    commit('[#T1] 实现 one', 'a.txt');
    expect(taskCommitInHead('T1')).not.toBeNull();
    expect(taskCommitInHead('T10')).toBeNull(); // 关键:T10 不应命中 T1 的 [#T1]
  });

  it('T10 的 commit 不被 T1 命中', () => {
    commit('[#T10] 实现 ten', 'b.txt');
    expect(taskCommitInHead('T10')).not.toBeNull();
    expect(taskCommitInHead('T1')).toBeNull(); // 关键:旧的裸 grep T1 会误命中 T10
  });

  it('旧式无标记 commit(feat(T1))不被识别为新契约', () => {
    commit('feat(T1): impl', 'c.txt');
    expect(taskCommitInHead('T1')).toBeNull();
  });

  it('taskCommitStatus 同样按 [#id] 边界判合并态', () => {
    commit('[#T1] 实现 one', 'd.txt');
    expect(taskCommitStatus('T1').status).toBe('merged');
    expect(taskCommitStatus('T10').status).toBeNull(); // 无 T10 commit
  });
});

describe('#2 done git 硬核验', () => {
  it('Claude 平台:无 [#id] commit 仍放行(仅警告,不破坏既有无人值守)', () => {
    setPlatform('claude');
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).toContain('未找到');
  });

  it('新平台(非 claude):无 [#id] commit → 阻断', () => {
    setPlatform('codex');
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('[#T1]');
  });

  it('新平台:主分支确有 [#T1] commit → 放行', () => {
    setPlatform('codex');
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    commit('[#T1] 实现 one', 'e.txt');
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).toBeUndefined();
  });

  it('--require-commit:Claude 平台无 commit 也阻断', () => {
    setPlatform('claude');
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    const r = runCommand(createDoneCommand(), ['T1', '5', '--require-commit']);
    expect(r.exitCode).not.toBe(0);
  });

  it('--force 旁路 commit 核验', () => {
    setPlatform('codex');
    const r = runCommand(createDoneCommand(), ['T1', '5', '--force']);
    expect(r.exitCode).toBeUndefined();
  });
});
