import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir, pkgRoot } from '../src/paths.js';
import { createInitCommand, ensureGitignore, GITIGNORE_ENTRIES } from '../src/commands/init.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { runCommand } from './helpers.js';

/**
 * 两个实战暴露的 bug(E2E 在真实 Claude Code 会话里跑出来):
 *
 * A. init 不写 .gitignore → .nightowl/ 全是未跟踪文件 → worktree cleanup 用
 *    `git status --porcelain` 判脏时会把自己铺的 harness 状态也算进去。
 * B. permission-mode.mjs 用子代理的 cwd 拼路径 → 子代理在 worktrees/<id> 里跑工具时
 *    造出 worktrees/<id>/.nightowl,同样让 cleanup 误判 WORKTREE_DIRTY。
 *
 * 两者叠加的实际后果:每个任务都留残留 worktree,无人值守下累积到后续合并全部失败。
 */

let root: string;
let prevCwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-gi-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function gitignore(): string {
  return fs.existsSync(path.join(root, '.gitignore'))
    ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    : '';
}

describe('init 自动忽略 .nightowl(Bug A)', () => {
  it('项目无 .gitignore 时创建,并写入 .nightowl/', () => {
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    runCommand(createInitCommand(), ['--skip-permissions']);

    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(true);
    expect(gitignore()).toContain('.nightowl/');
  });

  it('已有 .gitignore 时追加,且在尾部追加不粘行', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ndist/', 'utf8');
    runCommand(createInitCommand(), ['--skip-permissions']);

    const content = gitignore();
    expect(content).toContain('node_modules/');
    expect(content).toContain('dist/'); // 用户原有内容不动
    expect(content).toContain('.nightowl/');
    expect(content).toMatch(/dist\/\n/); // 原内容与追加块之间有换行
  });

  it('幂等:重复 init 不重复追加', () => {
    runCommand(createInitCommand(), ['--skip-permissions']);
    const first = gitignore();
    runCommand(createInitCommand(), ['--skip-permissions']);
    expect(gitignore()).toBe(first);
    expect(first.split('.nightowl/').length - 1).toBe(1);
  });

  it('等价写法已存在时不再追加(无尾斜杠也认)', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.nightowl\n', 'utf8');
    expect(ensureGitignore(root)).toBe('unchanged');
    expect(gitignore().split('.nightowl').length - 1).toBe(1);
  });

  it('返回 created / updated / unchanged 三态', () => {
    expect(ensureGitignore(root)).toBe('created');
    expect(ensureGitignore(root)).toBe('unchanged');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    expect(ensureGitignore(root)).toBe('updated');
  });

  it('回归:init 后 .nightowl/ 不再出现在 git status 里', () => {
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');

    runCommand(createInitCommand(), ['--skip-permissions']);
    spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: root, encoding: 'utf8' });

    // 任务池自身状态变化后,git status 必须仍然干净
    runCommand(createInitCommand(), ['--skip-permissions']);
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
      .stdout.trim();
    expect(status).not.toContain('.nightowl');
  });

  it('GITIGNORE_ENTRIES 覆盖所有需要忽略的目录', () => {
    expect(GITIGNORE_ENTRIES).toContain('.nightowl/');
  });
});

describe('permission-mode hook 写回项目根(Bug B)', () => {
  const hookSrc = (): string =>
    path.join(pkgRoot(), 'templates', 'hooks', 'permission-mode.mjs');

  /** 用给定 stdin JSON 跑 hook 脚本。 */
  function runHook(payload: object, env: Record<string, string> = {}): void {
    spawnSync('node', [hookSrc()], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
    });
  }

  function initPool(): void {
    runCommand(createInitCommand(), ['--skip-permissions']);
  }

  it('cwd 是 worktree 子目录时,仍写回项目根的 .nightowl', () => {
    initPool();
    const wt = path.join(root, '.nightowl', 'worktrees', 'T1');
    fs.mkdirSync(wt, { recursive: true });

    runHook({ permission_mode: 'bypass', cwd: wt });

    const rootMode = path.join(root, '.nightowl', '.permission-mode');
    expect(fs.existsSync(rootMode)).toBe(true);
    expect(fs.readFileSync(rootMode, 'utf8')).toBe('bypass');

    // 关键断言:worktree 内不许多出 .nightowl
    expect(fs.existsSync(path.join(wt, '.nightowl'))).toBe(false);
  });

  it('CLAUDE_PROJECT_DIR 优先于 cwd', () => {
    initPool();
    const wt = path.join(root, '.nightowl', 'worktrees', 'T2');
    fs.mkdirSync(wt, { recursive: true });

    runHook({ permission_mode: 'not_bypass', cwd: wt }, { CLAUDE_PROJECT_DIR: root });

    expect(fs.readFileSync(path.join(root, '.nightowl', '.permission-mode'), 'utf8')).toBe(
      'not_bypass',
    );
    expect(fs.existsSync(path.join(wt, '.nightowl'))).toBe(false);
  });

  it('项目未 init 时不凭空创建 .nightowl', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-nohook-'));
    try {
      runHook({ permission_mode: 'bypass', cwd: bare });
      expect(fs.existsSync(path.join(bare, '.nightowl'))).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('回归:子代理在真实 worktree 内跑过工具后,cleanup 不误报 DIRTY', () => {
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');
    // 注意:故意不 commit .gitignore —— 复现"用户没提交 init 写的 .gitignore"的场景,
    // 此时 setup 必须靠共享 info/exclude 兜底,否则新 worktree 里没有忽略规则。
    spawnSync('git', ['add', 'a.txt'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: root, encoding: 'utf8' });

    initPool();

    const setup = runCommand(createWorktreeCommand(), ['setup', 'T3']);
    expect(setup.stdout).toContain('WORKTREE_READY');
    const wt = path.join(root, '.nightowl', 'worktrees', 'T3');

    // 模拟子代理在 worktree 里跑了 N 次工具调用
    for (let i = 0; i < 3; i++) runHook({ permission_mode: 'bypass', cwd: wt });

    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })
      .stdout.trim();
    expect(dirty, `worktree 被 harness 弄脏: ${dirty}`).toBe('');

    const cleanup = runCommand(createWorktreeCommand(), ['cleanup', 'T3']);
    expect(cleanup.output).toContain('WORKTREE_CLEANED');
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('info/exclude 被写入且幂等(不重复追加)', () => {
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root, encoding: 'utf8' });
    initPool();

    runCommand(createWorktreeCommand(), ['setup', 'T4']);
    runCommand(createWorktreeCommand(), ['setup', 'T5']);

    const exclude = path.join(root, '.git', 'info', 'exclude');
    expect(fs.existsSync(exclude)).toBe(true);
    const content = fs.readFileSync(exclude, 'utf8');
    expect(content.split('\n').filter((l) => l.trim() === '.nightowl/')).toHaveLength(1);
  });
});
