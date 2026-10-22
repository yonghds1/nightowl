import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createPushCommand, selectPushRemote, isNonFastForward } from '../src/commands/push.js';
import { runCommand } from './helpers.js';

let root: string;
let remoteDir: string;
let extraRemotes: string[];
let prevCwd: string;

function git(args: string[], cwd: string = root): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

function bareRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  spawnSync('git', ['init', '--bare', '-q', dir], { encoding: 'utf8' });
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-push-'));
  remoteDir = bareRepo('nightowl-push-remote-');
  extraRemotes = [];
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  git(['remote', 'add', 'origin', remoteDir]);

  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
  for (const d of extraRemotes) fs.rmSync(d, { recursive: true, force: true });
});

/** 模拟"另一台机器"往远端同一分支推一个 commit。 */
function advanceRemote(branch: string, file = `remote-${Date.now()}.txt`): void {
  // 裸库默认 HEAD 可能指向不存在的分支,先对齐,否则 clone 出来是空工作区
  git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], remoteDir);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-push-other-'));
  extraRemotes.push(other);
  spawnSync('git', ['clone', '-q', remoteDir, other], { encoding: 'utf8' });
  git(['config', 'user.email', 'other@nightowl.local'], other);
  git(['config', 'user.name', 'Other'], other);
  // clone 出的分支可能不是目标分支(裸库 HEAD 未指向时),直接落到目标分支
  git(['checkout', '-q', '-B', branch], other);
  fs.writeFileSync(path.join(other, file), 'from elsewhere', 'utf8');
  git(['add', file], other);
  git(['commit', '-q', '-m', 'remote advance'], other);
  expect(git(['push', '-q', 'origin', `HEAD:${branch}`], other).status).toBe(0);
}

describe('nightowl push 的 remote 选择', () => {
  it('优先当前分支跟踪的 remote', () => {
    expect(selectPushRemote(['origin', 'upstream'], 'upstream')).toBe('upstream');
    expect(selectPushRemote(['origin', 'upstream'], null)).toBe('origin');
    expect(selectPushRemote(['upstream'], null)).toBe('upstream');
    expect(selectPushRemote(['a', 'b'], null)).toBeNull();
    expect(selectPushRemote([], null)).toBeNull();
  });

  it('识别 non-fast-forward 拒绝文案(含 LC_ALL=C 下的 fetch first)', () => {
    expect(isNonFastForward(' ! [rejected] main -> main (fetch first)')).toBe(true);
    expect(isNonFastForward('error: failed to push some refs')).toBe(false);
  });
});

describe('nightowl push 的无人值守防线', () => {
  it('detached HEAD → PUSH_DETACHED,不会误推 main', () => {
    expect(git(['checkout', '-q', '--detach']).status).toBe(0);
    const r = runCommand(createPushCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('PUSH_DETACHED');
  });

  it('没有 origin 但只有一个 remote → 推送并建立 upstream', () => {
    const up = bareRepo('nightowl-push-upstream-');
    extraRemotes.push(up);
    git(['remote', 'remove', 'origin']);
    git(['remote', 'add', 'upstream', up]);

    const r = runCommand(createPushCommand(), []);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('PUSH_OK');

    const branch = git(['branch', '--show-current']).stdout;
    expect(git(['rev-parse', '--verify', '--quiet', `refs/remotes/upstream/${branch}`]).status).toBe(0);
    expect(git(['rev-parse', branch], up).stdout).toBe(git(['rev-parse', 'HEAD']).stdout);
    // upstream 必须真的建立,否则 git status 永远看不到 ahead/behind
    expect(git(['config', '--get', `branch.${branch}.merge`]).stdout).toBe(`refs/heads/${branch}`);
  });

  it('远端 ref 已存在但本地分支没跟踪 → 仍然用 -u 建立 upstream', () => {
    const branch = git(['branch', '--show-current']).stdout;
    // 用原生 git 推一次(不带 -u):远端 ref 有了,但 branch.<name>.merge 仍未配置
    expect(git(['push', '-q', 'origin', branch]).status).toBe(0);
    expect(git(['config', '--get', `branch.${branch}.merge`]).stdout).toBe('');

    git(['commit', '-q', '--allow-empty', '-m', 'local work']);
    const r = runCommand(createPushCommand(), []);
    expect(r.stdout).toContain('PUSH_OK');
    expect(git(['config', '--get', `branch.${branch}.merge`]).stdout).toBe(`refs/heads/${branch}`);
  });

  it('多个 remote 且无 origin/无跟踪 → PUSH_NO_REMOTE_SELECTED,不猜', () => {
    const a = bareRepo('nightowl-push-a-');
    const b = bareRepo('nightowl-push-b-');
    extraRemotes.push(a, b);
    git(['remote', 'remove', 'origin']);
    git(['remote', 'add', 'alpha', a]);
    git(['remote', 'add', 'beta', b]);

    const r = runCommand(createPushCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('PUSH_NO_REMOTE_SELECTED');
  });

  it('双方都有新提交 → PUSH_DIVERGED(先同步,不做无谓 push)', () => {
    const branch = git(['branch', '--show-current']).stdout;
    expect(runCommand(createPushCommand(), []).stdout).toContain('PUSH_OK');
    advanceRemote(branch);
    git(['commit', '-q', '--allow-empty', '-m', 'local night work']);

    const r = runCommand(createPushCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('PUSH_DIVERGED');
    expect(r.output).toContain('rebase');
  });

  it('只落后不领先 → PUSH_NOTHING(fetch 后无内容可推)', () => {
    const branch = git(['branch', '--show-current']).stdout;
    expect(runCommand(createPushCommand(), []).stdout).toContain('PUSH_OK');
    advanceRemote(branch);

    const r = runCommand(createPushCommand(), []);
    expect(r.stdout).toContain('PUSH_NOTHING');
  });

  it('--no-fetch 走本地陈旧状态 → 由远端拒绝并报 PUSH_REJECTED', () => {
    const branch = git(['branch', '--show-current']).stdout;
    expect(git(['push', '-q', 'origin', branch]).status).toBe(0);
    git(['commit', '-q', '--allow-empty', '-m', 'local work']);
    advanceRemote(branch);

    const r = runCommand(createPushCommand(), ['--no-fetch']);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('PUSH_REJECTED');
    expect(r.output).toContain('rebase');
  });
});
