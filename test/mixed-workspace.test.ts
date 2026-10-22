import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir, getBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAnalyzeCommand } from '../src/commands/analyze.js';
import { createPreflightCommand, runPreflight } from '../src/commands/preflight.js';
import { createAddCommand } from '../src/commands/add.js';
import { createNextCommand } from '../src/commands/next.js';
import { createCommitCommand } from '../src/commands/commit.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createReviewCommand } from '../src/commands/review.js';
import { createDoneCommand } from '../src/commands/done.js';
import { createPushCommand } from '../src/commands/push.js';
import { loadPool } from '../src/state.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;
const prevEnv = { ...process.env };
function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}
function repo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Mixed Test']);
  git(dir, ['config', 'user.email', 'mixed@example.invalid']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base']);
  return dir;
}
function add(verify = 'true'): void {
  expect(runCommand(createAddCommand(), ['--id', 'T1', '--title', 'mixed test', '--est-min', '15', '--verify', verify]).exitCode).toBeUndefined();
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-mixed-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  process.env.NIGHTOWL_LANG = 'en';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  runCommand(createInitCommand(), ['--skip-permissions', '--claude', '-u', 'mixed-test']);
});
afterEach(() => {
  process.chdir(prevCwd);
  process.env = { ...prevEnv };
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mixed workspace lifecycle', () => {
  it('preflights, discovers, commits each subrepo, verifies and completes without root Git', () => {
    const a = repo('repo-a');
    const b = repo('repo b');
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const dir of [a, b, path.join(root, 'scripts')]) {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"node --check task.js"}}');
    }
    const analyzed = runCommand(createAnalyzeCommand(), []);
    expect(analyzed.output).toContain('repo-a');
    expect(analyzed.output).toContain('repo b');
    expect(analyzed.output).toContain('node --check task.js');
    const preflight = runCommand(createPreflightCommand(), []);
    expect(preflight.output).toContain('PREFLIGHT_OK');
    add('node --check repo-a/task.js && node --check "repo b/task.js" && node --check scripts/task.js');
    expect(runCommand(createNextCommand(), []).output).toContain('T1');
    expect(runCommand(createWorktreeCommand(), ['setup', 'T1']).output).toContain('WORKTREE_SKIPPED:');
    const rootCommit = runCommand(createCommitCommand(), ['--task', 'T1', '-m', 'task', '--all']);
    expect(rootCommit.exitCode).toBe(1);
    expect(rootCommit.output).not.toContain('detached HEAD');
    expect(rootCommit.output).toContain('COMMIT_FAIL');
    for (const dir of [a, b, path.join(root, 'scripts')]) fs.writeFileSync(path.join(dir, 'task.js'), 'const value = 1;\n');
    for (const dir of [a, b]) {
      process.chdir(dir);
      expect(getBaseDir()).toBe(path.join(root, '.nightowl'));
      const committed = runCommand(createCommitCommand(), ['--task', 'T1', '-m', 'implement', '--all']);
      expect(committed.output).toContain('COMMIT_OK');
      expect(git(dir, ['log', '-1', '--format=%s'])).toContain('[#T1]');
    }
    process.chdir(root);
    expect(runCommand(createVerifyCommand(), ['--id', 'T1']).output).toContain('ALL_PASS');
    expect(loadPool()?.pool[0].verify_passed?.head).toBeUndefined();
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    expect(runCommand(createWorktreeCommand(), ['merge', 'T1']).output).toContain('WORKTREE_MERGE_SKIPPED');
    expect(runCommand(createWorktreeCommand(), ['cleanup', 'T1']).output).toContain('WORKTREE_CLEAN_SKIPPED');
    expect(runCommand(createDoneCommand(), ['T1']).exitCode).toBeUndefined();
    expect(loadPool()?.pool[0].status).toBe('done');
    expect(runCommand(createPushCommand(), []).output).toContain('PUSH_SKIPPED_NO_GIT');
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('allows a pure non-Git root even with --strict, but requires initialization', () => {
    expect(runCommand(createPreflightCommand(), ['--strict']).output).toContain('PREFLIGHT_OK');
    fs.rmSync(path.join(root, '.nightowl'), { recursive: true });
    expect(runCommand(createPreflightCommand(), []).exitCode).toBe(1);
  });

  it.each(['detached', 'identity', 'merge', 'empty'])('rejects an unsafe subrepo: %s', (reason) => {
    const dir = repo('unsafe');
    if (reason === 'detached') git(dir, ['checkout', '-q', '--detach']);
    if (reason === 'identity') git(dir, ['config', '--unset', 'user.email']);
    if (reason === 'merge') fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), git(dir, ['rev-parse', 'HEAD']));
    if (reason === 'empty') {
      fs.rmSync(path.join(dir, '.git'), { recursive: true });
      git(dir, ['init', '-q']);
      git(dir, ['config', 'user.name', 'Empty Test']);
      git(dir, ['config', 'user.email', 'empty@example.invalid']);
    }
    const failed = runCommand(createPreflightCommand(), []);
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain('unsafe');
    if (reason === 'empty') expect(failed.output).toContain('no usable HEAD');
  });

  it('warns about a dirty subrepo without modifying it, and strict rejects it', () => {
    const dir = repo('dirty');
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'user work');
    expect(runPreflight().some((c) => c.level === 'warn' && c.message.includes('dirty'))).toBe(true);
    expect(runCommand(createPreflightCommand(), ['--strict']).exitCode).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8')).toBe('user work');
  });

  it('fails on missing Git and damaged .git instead of allowing downgrade', () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nightowl-missing-git';
    try {
      expect(runCommand(createPreflightCommand(), []).exitCode).toBe(1);
      expect(runCommand(createCommitCommand(), ['--task', 'T1', '-m', 'test']).output).toContain('COMMIT_FAIL');
    } finally { process.env.PATH = oldPath; }
    fs.mkdirSync(path.join(root, 'broken', '.git'), { recursive: true });
    const failed = runCommand(createPreflightCommand(), []);
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain('broken');
  });

  it('fails preflight when discovery is truncated and reports partial analyze output', () => {
    fs.mkdirSync(path.join(root, 'a/b/c/d/e'), { recursive: true });
    const failed = runCommand(createPreflightCommand(), []);
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain('limit');
    expect(runCommand(createAnalyzeCommand(), []).output).toContain('limit');
  });

  it('does not complete a task after a failing real check', () => {
    add('node --check missing.js');
    expect(runCommand(createVerifyCommand(), ['--id', 'T1']).exitCode).toBe(1);
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    expect(runCommand(createDoneCommand(), ['T1']).exitCode).toBe(1);
    expect(loadPool()?.pool[0].status).not.toBe('done');
  });
});
