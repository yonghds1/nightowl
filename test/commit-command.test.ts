import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createCommitCommand, ensureTaskMarker, taskMarkers } from '../src/commands/commit.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;
const prevEnv = { ...process.env };

function git(args: string[], cwd: string = root): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-commit-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  process.env.NIGHTOWL_LANG = 'en';

  runCommand(createInitCommand(), ['--skip-permissions']);
  runCommand(createAddCommand(), ['--id', 'T1', '--title', 'task one', '--priority', 'P1', '--est-min', '15']);
});

afterEach(() => {
  process.chdir(prevCwd);
  process.env = { ...prevEnv };
  fs.rmSync(root, { recursive: true, force: true });
});

function lastSubject(): string {
  return git(['log', '-1', '--format=%s']).stdout;
}

describe('commit message 标记处理', () => {
  it('缺标记 → 补到标题行首;已有 → 不重复', () => {
    expect(ensureTaskMarker('feat: add thing', 'T1')).toBe('[#T1] feat: add thing');
    expect(ensureTaskMarker('[#T1] feat: add thing', 'T1')).toBe('[#T1] feat: add thing');
    expect(ensureTaskMarker('feat: x\n\nbody text', 'T1')).toBe('[#T1] feat: x\n\nbody text');
    expect(taskMarkers('a [#T1] b [#T2]')).toEqual(['T1', 'T2']);
  });
});

describe('nightowl commit', () => {
  it('--all 提交并把 [#id] 自动写进标题', () => {
    fs.writeFileSync(path.join(root, 'feature.txt'), 'impl', 'utf8');
    const r = runCommand(createCommitCommand(), [
      '--task', 'T1', '-m', 'feat: add feature', '--all',
    ]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('COMMIT_OK');
    expect(lastSubject()).toBe('[#T1] feat: add feature');
    expect(git(['log', '-1', '--name-only', '--format=']).stdout).toContain('feature.txt');
  });

  it('默认只提交已暂存改动,不把其它未跟踪文件卷进来', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b', 'utf8');
    git(['add', 'a.txt']);

    const r = runCommand(createCommitCommand(), ['--task', 'T1', '-m', 'feat: only a']);
    expect(r.stdout).toContain('COMMIT_OK');
    const files = git(['log', '-1', '--name-only', '--format=']).stdout;
    expect(files).toContain('a.txt');
    expect(files).not.toContain('b.txt');
    expect(git(['status', '--porcelain']).stdout).toContain('?? b.txt');
  });

  it('没有可提交改动 → COMMIT_FAIL,不产生空提交', () => {
    const before = git(['rev-parse', 'HEAD']).stdout;
    const r = runCommand(createCommitCommand(), ['--task', 'T1', '-m', 'feat: nothing']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('COMMIT_FAIL');
    expect(git(['rev-parse', 'HEAD']).stdout).toBe(before);
  });

  it('message 里有别的任务标记 → 拒绝提交', () => {
    fs.writeFileSync(path.join(root, 'x.txt'), 'x', 'utf8');
    const r = runCommand(createCommitCommand(), [
      '--task', 'T1', '-m', '[#T2] wrong owner', '--all',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('COMMIT_FAIL');
    expect(r.output).toContain('[#T2]');
    expect(lastSubject()).toBe('base');
  });

  it('--allow-empty 可用(done 前打点)', () => {
    const r = runCommand(createCommitCommand(), [
      '--task', 'T1', '-m', 'chore: checkpoint', '--allow-empty',
    ]);
    expect(r.stdout).toContain('COMMIT_OK');
    expect(lastSubject()).toBe('[#T1] chore: checkpoint');
  });

  it('detached HEAD → COMMIT_FAIL 并提示切分支', () => {
    expect(git(['checkout', '-q', '--detach']).status).toBe(0);
    fs.writeFileSync(path.join(root, 'x.txt'), 'x', 'utf8');
    const r = runCommand(createCommitCommand(), ['--task', 'T1', '-m', 'x', '--all']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('COMMIT_FAIL');
    expect(r.output).toContain('switch');
  });
});
