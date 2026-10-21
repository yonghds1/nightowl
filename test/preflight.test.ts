import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createPreflightCommand, runPreflight } from '../src/commands/preflight.js';
import { runCommand } from './helpers.js';

let root: string;
let remoteDir: string;
let prevCwd: string;
const prevEnv = { ...process.env };

function git(args: string[], cwd: string = root): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-preflight-'));
  remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-preflight-remote-'));
  spawnSync('git', ['init', '--bare', '-q', remoteDir], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@nightowl.local']);
  git(['config', 'user.name', 'Nightowl Tester']);
  git(['remote', 'add', 'origin', remoteDir]);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);

  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  process.env.NIGHTOWL_LANG = 'en';
});

afterEach(() => {
  process.chdir(prevCwd);
  process.env = { ...prevEnv };
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

/** 注意:setBaseDir('') 会写入空串,这里用显式重置避免影响后续用例。 */
describe('nightowl preflight', () => {
  it('仓库/初始化/身份/remote 齐全 → PREFLIGHT_OK', () => {
    runCommand(createInitCommand(), ['--skip-permissions']);
    const r = runCommand(createPreflightCommand(), []);
    expect(r.output).toContain('PREFLIGHT_OK');
    expect(r.exitCode).toBeUndefined();
    expect(r.output).not.toContain('❌');
  });

  it('未初始化 .nightowl → 失败并给出 init 修复命令', () => {
    const r = runCommand(createPreflightCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('PREFLIGHT_FAIL:');
    expect(r.output).toContain('nightowl init');
  });

  it('detached HEAD → 失败并提示切回分支', () => {
    runCommand(createInitCommand(), ['--skip-permissions']);
    const r0 = spawnSync('git', ['checkout', '-q', '--detach'], { cwd: root, encoding: 'utf8' });
    expect(r0.status).toBe(0);

    const r = runCommand(createPreflightCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Detached HEAD');
    expect(r.output).toContain('git switch');
  });

  it('未配置提交身份 → 失败', () => {
    runCommand(createInitCommand(), ['--skip-permissions']);
    // 隔离全局/系统配置并清掉仓库内身份,模拟容器/CI 常见状态
    git(['config', '--unset', 'user.email']);
    git(['config', '--unset', 'user.name']);
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';

    const checks = runPreflight();
    const identity = checks.find((c) => c.message.includes('identity'));
    expect(identity?.level).toBe('fail');
  });

  it('工作区脏 → 仅警告,仍算通过;--strict 下升级为失败', () => {
    runCommand(createInitCommand(), ['--skip-permissions']);
    fs.writeFileSync(path.join(root, 'wip.txt'), 'work in progress', 'utf8');

    const relaxed = runCommand(createPreflightCommand(), []);
    expect(relaxed.output).toContain('uncommitted');
    expect(relaxed.output).toContain('PREFLIGHT_OK');
    expect(relaxed.exitCode).toBeUndefined();

    const strict = runCommand(createPreflightCommand(), ['--strict']);
    expect(strict.output).toContain('uncommitted');
    expect(strict.output).toContain('PREFLIGHT_FAIL:');
    expect(strict.exitCode).toBe(1);
  });

  it('幽灵 worktree(目录被手工删除)→ 提示 git worktree prune', () => {
    runCommand(createInitCommand(), ['--skip-permissions']);
    git(['worktree', 'add', '-q', path.join(root, '.nightowl', 'worktrees', 'T1'), '-b', 'nightowl/T1']);
    fs.rmSync(path.join(root, '.nightowl', 'worktrees', 'T1'), { recursive: true, force: true });

    const r = runCommand(createPreflightCommand(), []);
    expect(r.output).toContain('stale metadata');
    expect(r.output).toContain('git worktree prune');
  });
});
