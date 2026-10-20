import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { loadPool, loadState, loadCheckpoint } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createDoneCommand } from '../src/commands/done.js';
import { createAnalyzeCommand } from '../src/commands/analyze.js';
import { createBlockCommand } from '../src/commands/block.js';
import { createCheckpointCommand } from '../src/commands/checkpoint.js';
import { createPushCommand } from '../src/commands/push.js';
import { runCommand } from './helpers.js';

let root: string;
let prevCwd: string;
let remoteDir: string | null = null;

function git(args: string[], cwd: string = root): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
}

function initRepo(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 't']);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-basic-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
  if (remoteDir) {
    fs.rmSync(remoteDir, { recursive: true, force: true });
    remoteDir = null;
  }
});

function initPool(): void {
  runCommand(createInitCommand(), ['--skip-permissions']);
}

function addTask(id: string, extra: string[] = []): void {
  runCommand(createAddCommand(), [
    '--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '15', ...extra,
  ]);
}

function contextFile(): string {
  return path.join(root, '.nightowl', 'nightowl.context.md');
}

describe('analyze 生成项目上下文文件', () => {
  it('空目录也能产出 context 文件,不崩', () => {
    initPool();
    const r = runCommand(createAnalyzeCommand(), []);
    expect(r.exitCode).toBeUndefined();
    expect(fs.existsSync(contextFile())).toBe(true);
    expect(fs.readFileSync(contextFile(), 'utf8').length).toBeGreaterThan(0);
  });

  it('识别构建文件并摘出测试命令(拆任务时验收命令的依据)', () => {
    initPool();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc', lint: 'eslint .' } }, null, 2),
      'utf8',
    );
    runCommand(createAnalyzeCommand(), []);
    const content = fs.readFileSync(contextFile(), 'utf8');
    expect(content).toContain('package.json');
    // 回归：曾因逐行扫 JSON 时把所有 `"` 开头的行过滤掉,这里永远为空且不报错。
    expect(content).toContain('vitest run');
    expect(content).toContain('tsc');
    expect(content).toContain('eslint');
  });

  it('package.json 无 scripts 时退化记录依赖名(仍留技术栈线索)', () => {
    initPool();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { commander: '^14.0.0' } }, null, 2),
      'utf8',
    );
    runCommand(createAnalyzeCommand(), []);
    expect(fs.readFileSync(contextFile(), 'utf8')).toContain('commander');
  });

  it('package.json 损坏时不崩,退化到逐行扫描', () => {
    initPool();
    fs.writeFileSync(path.join(root, 'package.json'), '{{{ broken json', 'utf8');
    const r = runCommand(createAnalyzeCommand(), []);
    expect(r.exitCode).toBeUndefined();
    expect(fs.existsSync(contextFile())).toBe(true);
  });

  it('识别 .github/workflows 里的 CI 工作流', () => {
    initPool();
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  test:\n    steps:\n      - run: npm test\n',
      'utf8',
    );
    runCommand(createAnalyzeCommand(), []);
    const content = fs.readFileSync(contextFile(), 'utf8');
    expect(content).toContain('ci.yml');
  });

  it('识别关键目录及文件清单', () => {
    initPool();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '', 'utf8');
    runCommand(createAnalyzeCommand(), []);
    const content = fs.readFileSync(contextFile(), 'utf8');
    expect(content).toContain('index.ts');
  });
});

describe('block 阻塞任务', () => {
  it('同步 pool / state / checkpoint 三处落盘', () => {
    initPool();
    addTask('T1');

    const r = runCommand(createBlockCommand(), ['T1', '上游接口未就绪']);
    expect(r.exitCode).toBeUndefined();

    expect(loadPool()!.pool.find((t) => t.id === 'T1')!.status).toBe('blocked');

    const state = loadState();
    expect(state.blocked).toHaveLength(1);
    expect(state.blocked[0]).toMatchObject({ id: 'T1', reason: '上游接口未就绪' });
    expect(state.in_progress).toBeNull();

    // 阻塞是中断点,必须立刻固化为 checkpoint
    expect(loadCheckpoint()).not.toBeNull();
  });

  it('不存在的任务 id 退出 1', () => {
    initPool();
    const r = runCommand(createBlockCommand(), ['T404', 'x']);
    expect(r.exitCode).toBe(1);
  });

  it('没有任务池时退出 1', () => {
    const r = runCommand(createBlockCommand(), ['T1', 'x']);
    expect(r.exitCode).toBe(1);
  });
});

describe('checkpoint 手动管理', () => {
  it('save → status 报 CHECKPOINT_EXISTS,clear 后回落到 CHECKPOINT_NONE', () => {
    initPool();
    addTask('T1');
    addTask('T2');

    const rNone = runCommand(createCheckpointCommand(), ['status']);
    expect(rNone.stdout).toContain('CHECKPOINT_NONE');

    const rSave = runCommand(createCheckpointCommand(), ['save']);
    expect(rSave.exitCode).toBeUndefined();
    expect(loadCheckpoint()).not.toBeNull();

    const rStatus = runCommand(createCheckpointCommand(), ['status']);
    expect(rStatus.stdout).toContain('CHECKPOINT_EXISTS: 2');

    runCommand(createCheckpointCommand(), ['load']);
    expect(loadCheckpoint()!.stats).toMatchObject({ total: 2, completed: 0 });

    runCommand(createCheckpointCommand(), ['clear']);
    expect(loadCheckpoint()).toBeNull();
    expect(runCommand(createCheckpointCommand(), ['status']).stdout).toContain('CHECKPOINT_NONE');
  });

  it('全部完成时 status 报 CHECKPOINT_DONE', () => {
    initPool();
    addTask('T1');
    runCommand(createDoneCommand(), ['T1', '--force']);
    expect(runCommand(createCheckpointCommand(), ['status']).stdout).toContain('CHECKPOINT_DONE');
  });

  it('save 时没有任务池退出 1', () => {
    const r = runCommand(createCheckpointCommand(), ['save']);
    expect(r.exitCode).toBe(1);
  });

  it('未知动作退出 1', () => {
    initPool();
    const r = runCommand(createCheckpointCommand(), ['bogus']);
    expect(r.exitCode).toBe(1);
  });
});

describe('push 推送未推送的 commit', () => {
  beforeEach(() => {
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-push-remote-'));
    spawnSync('git', ['init', '--bare', '-q', remoteDir], { encoding: 'utf8' });
  });

  function syncToRemote(): string {
    initRepo();
    git(['commit', '-q', '--allow-empty', '-m', 'base']);
    git(['remote', 'add', 'origin', remoteDir as string]);
    const branch = git(['branch', '--show-current']);
    git(['push', '-q', '-u', 'origin', branch]);
    return branch;
  }

  it('没有 remote → PUSH_SKIPPED_NO_REMOTE', () => {
    initRepo();
    git(['commit', '-q', '--allow-empty', '-m', 'base']);
    const r = runCommand(createPushCommand(), []);
    expect(r.stdout).toContain('PUSH_SKIPPED_NO_REMOTE');
    expect(r.exitCode).toBeUndefined();
  });

  it('全部已推送 → PUSH_NOTHING', () => {
    syncToRemote();
    const r = runCommand(createPushCommand(), []);
    expect(r.stdout).toContain('PUSH_NOTHING');
    expect(r.stdout).not.toContain('PUSH_OK');
  });

  it('有未推送 commit → PUSH_OK 且远端真的收到', () => {
    const branch = syncToRemote();
    git(['commit', '-q', '--allow-empty', '-m', 'night work']);

    const r = runCommand(createPushCommand(), []);
    expect(r.stdout).toContain('PUSH_OK');

    const localHead = git(['rev-parse', 'HEAD']);
    const remoteHead = spawnSync('git', ['-C', remoteDir as string, 'rev-parse', branch], {
      encoding: 'utf8',
    }).stdout.trim();
    expect(remoteHead).toBe(localHead);
  });
});
