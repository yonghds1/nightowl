import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { pkgRoot } from '../src/paths.js';
import type { Pool } from '../src/state.js';

const cli = path.join(pkgRoot(), 'bin', 'nightowl.js');
let root: string;
let caller: string;
const env = {
  ...process.env, NIGHTOWL_LANG: 'en', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
function run(args: string[], expected = 0, cwd = caller, extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000,
  });
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(expected);
  return output;
}
function git(dir: string, args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function initialize(): void {
  run(['--dir', root, 'init', '--skip-permissions', '--claude', '-u', 'cli-test']);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-mixed-cli-'));
  caller = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-caller-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(caller, { recursive: true, force: true });
});

describe('built CLI mixed workspace contracts', () => {
  it('uses --dir for root scheduling and ancestor state for child commits', () => {
    for (const name of ['repo-a', 'repo b']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      git(dir, ['init', '-q']);
      git(dir, ['config', 'user.name', 'CLI Test']);
      git(dir, ['config', 'user.email', 'cli@example.invalid']);
      fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"node --check task.js"}}');
      git(dir, ['add', 'package.json']);
      git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    }
    fs.mkdirSync(path.join(root, 'scripts'));
    initialize();
    expect(run(['--dir', root, 'analyze'])).toContain('repo b');
    expect(run(['--dir', root, 'preflight'])).toContain('PREFLIGHT_OK');
    run(['--dir', root, 'add', '--id', 'T1', '--title', 'CLI mixed task', '--est-min', '15',
      '--verify', 'node --check repo-a/task.js && node --check "repo b/task.js" && node --check scripts/task.js']);
    expect(run(['--dir', root, 'next'])).toContain('WORKTREE_ROOT:');
    expect(run(['--dir', root, 'worktree', 'setup', 'T1'])).toContain('WORKTREE_SKIPPED:');
    const failed = run(['--dir', root, 'commit', '--task', 'T1', '-m', 'test'], 1);
    expect(failed).toContain('COMMIT_FAIL');
    expect(failed).not.toContain('detached HEAD');
    for (const name of ['repo-a', 'repo b', 'scripts']) {
      const dir = path.join(root, name);
      fs.writeFileSync(path.join(dir, 'task.js'), 'const value = 1;\n');
      if (name !== 'scripts') {
        git(dir, ['add', 'task.js']);
        expect(run(['commit', '--task', 'T1', '-m', 'Implement'], 0, dir)).toContain('COMMIT_OK');
      }
    }
    expect(run(['--dir', root, 'verify', '--id', 'T1'])).toContain('ALL_PASS');
    run(['--dir', root, 'review', 'T1', '--result', 'PASS']);
    expect(run(['--dir', root, 'worktree', 'merge', 'T1'])).toContain('WORKTREE_MERGE_SKIPPED:');
    expect(run(['--dir', root, 'worktree', 'cleanup', 'T1'])).toContain('WORKTREE_CLEAN_SKIPPED:');
    run(['--dir', root, 'done', 'T1']);
    const pool = yaml.load(fs.readFileSync(path.join(root, '.nightowl/nightowl.tasks.yaml'), 'utf8')) as Pool;
    expect(pool.pool[0].status).toBe('done');
    expect(pool.pool[0].verify_passed?.head).toBeUndefined();
    expect(run(['--dir', root, 'push'])).toContain('PUSH_SKIPPED_NO_GIT');
    expect(run(['--dir', root, 'sweep', '--clean'])).toContain('SWEEP_CLEAN');
    run(['--dir', root, 'report']);
    expect(fs.existsSync(path.join(root, '.nightowl/nightowl.report.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(caller, '.nightowl'))).toBe(false);
  });

  it('plain root passes strict preflight and missing Git never becomes a success', () => {
    initialize();
    expect(run(['--dir', root, 'preflight', '--strict'])).toContain('PREFLIGHT_OK');
    fs.writeFileSync(path.join(root, 'task.js'), 'const value = 1;\n');
    run(['--dir', root, 'add', '--id', 'P1', '--title', 'Plain task', '--est-min', '5', '--verify', 'node --check task.js']);
    expect(run(['--dir', root, 'worktree', 'setup', 'P1'])).toContain('WORKTREE_SKIPPED:');
    expect(run(['--dir', root, 'verify', '--id', 'P1'])).toContain('ALL_PASS');
    run(['--dir', root, 'review', 'P1', '--result', 'PASS']);
    run(['--dir', root, 'done', 'P1']);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
    expect(run(['--dir', root, 'preflight'], 1, caller, { PATH: '/missing-nightowl-git' })).toContain('PREFLIGHT_FAIL:');
    for (const args of [['push'], ['sweep', '--clean'], ['worktree', 'list']]) {
      const output = run(['--dir', root, ...args], 1, caller, { PATH: '/missing-nightowl-git' });
      expect(output).not.toContain('PUSH_SKIPPED_NO_GIT');
      expect(output).not.toContain('SWEEP_CLEAN');
      expect(output).not.toContain('WORKTREE_EMPTY');
    }
  });
});
