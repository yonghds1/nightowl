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

function git(args: string[], cwd: string = root): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
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

  it('没有 origin 但只有一个 remote → 正常推送并建立 upstream', () => {
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

  it('远端已前进 → PUSH_REJECTED 且给出 rebase 下一步', () => {
    const branch = git(['branch', '--show-current']).stdout;
    expect(runCommand(createPushCommand(), []).stdout).toContain('PUSH_OK');
    git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], remoteDir);

    // 另一处 clone 推一个新 commit,让远端前进
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-push-other-'));
    extraRemotes.push(other);
    spawnSync('git', ['clone', '-q', remoteDir, other], { encoding: 'utf8' });
    git(['config', 'user.email', 'other@nightowl.local'], other);
    git(['config', 'user.name', 'Other'], other);
    fs.writeFileSync(path.join(other, 'remote.txt'), 'from elsewhere', 'utf8');
    git(['add', 'remote.txt'], other);
    git(['commit', '-q', '-m', 'remote advance'], other);
    expect(git(['push', '-q', 'origin', `HEAD:${branch}`], other).status).toBe(0);

    git(['commit', '-q', '--allow-empty', '-m', 'local night work']);
    const r = runCommand(createPushCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('PUSH_REJECTED');
    expect(r.output).toContain('rebase');
  });
});
