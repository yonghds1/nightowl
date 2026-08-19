import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { loadPool, savePool } from '../src/state.js';
import { datePrefix } from '../src/util.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createNextCommand } from '../src/commands/next.js';
import { createStatusCommand } from '../src/commands/status.js';
import { createReportCommand } from '../src/commands/report.js';
import { runCommand } from './helpers.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-prd-'));
  setBaseDir(path.join(root, '.nightowl'));
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function add(id: string, title: string, extra: string[] = []): void {
  const args = ['--id', id, '--title', title, '--priority', 'P1', '--est-min', '15', ...extra];
  runCommand(createAddCommand(), args);
}

function prdPath(name: string, assignee = 'nightowl-user'): string {
  return path.join(root, '.nightowl', 'tasks', assignee, `${datePrefix()}-${name}`, 'prd.md');
}

function readPool() {
  return loadPool()!;
}

describe('add 生成关联 PRD 文档', () => {
  it('init 创建 tasks 目录', () => {
    expect(fs.existsSync(path.join(root, '.nightowl', 'tasks'))).toBe(true);
  });

  it('ASCII title 创建 PRD(验收拆 checklist、verify 转命令清单)', () => {
    add('T1', 'Add reverse function', [
      '--acceptance',
      '反转字符串;空串返回空',
      '--verify',
      'npm test',
    ]);
    const prd = prdPath('add-reverse-function');
    expect(fs.existsSync(prd)).toBe(true);
    const content = fs.readFileSync(prd, 'utf8');
    expect(content).toContain('# Add reverse function');
    expect(content).toContain('- [ ] 反转字符串');
    expect(content).toContain('- [ ] `npm test`');
  });

  it('pool 中设置 prd_path', () => {
    add('T1', 'Add reverse function');
    const t = readPool().pool.find((x) => x.id === 'T1')!;
    expect(t.prd_path).toMatch(new RegExp(`nightowl-user/${datePrefix()}-add-reverse-function/prd\\.md$`));
    expect(t.prd_path).toMatch(/^\.nightowl\/tasks\//);
    expect(fs.existsSync(path.join(root, t.prd_path!))).toBe(true);
  });

  it('中文 title 回退到任务 id', () => {
    add('T1', '中文任务标题');
    expect(fs.existsSync(prdPath('t1'))).toBe(true);
  });

  it('显式 slug', () => {
    add('T1', 'Whatever title', ['--slug', 'my-slug']);
    expect(fs.existsSync(prdPath('my-slug'))).toBe(true);
  });

  it('同 slug 冲突自动递增', () => {
    add('T1', 'Add reverse', ['--slug', 'dup']);
    add('T2', 'Add other', ['--slug', 'dup']);
    expect(fs.existsSync(prdPath('dup'))).toBe(true);
    expect(fs.existsSync(prdPath('dup-2'))).toBe(true);
  });

  it('next 打印 PRD_PATH', () => {
    add('T1', 'Add reverse function');
    const r = runCommand(createNextCommand(), []);
    expect(r.stdout).toContain('PRD_PATH:');
    expect(r.stdout).toContain(`nightowl-user/${datePrefix()}-add-reverse-function/prd.md`);
    expect(r.stdout).toContain('WORKTREE_ROOT:');
  });
});

describe('add assignee 默认逻辑', () => {
  it('无 .developer 且未传 --assignee → nightowl-user', () => {
    add('T1', 'Add reverse function');
    expect(readPool().pool[0].assignee).toBe('nightowl-user');
  });

  it('--assignee 显式 → 使用指定名', () => {
    add('T1', 'Add reverse function', ['--assignee', '张三']);
    expect(readPool().pool[0].assignee).toBe('张三');
  });

  it('.developer 存在 → 读它为默认', () => {
    fs.writeFileSync(path.join(root, '.nightowl', '.developer'), '李四\n');
    add('T1', 'Add reverse function');
    expect(readPool().pool[0].assignee).toBe('李四');
  });

  it('status 任务行显示负责人', () => {
    add('T1', 'Add reverse function', ['--assignee', '张三']);
    const r = runCommand(createStatusCommand(), []);
    expect(r.stdout).toContain('负责人张三');
  });

  it('report 表格显示负责人列', () => {
    add('T1', 'Add reverse function', ['--assignee', '李四']);
    const r = runCommand(createReportCommand(), []);
    expect(r.stdout).toContain('| 负责人 |');
    expect(r.stdout).toContain('| T1 | 李四 |');
  });

  it('旧任务无 assignee → status 显示未指派', () => {
    add('T1', 'Add reverse function');
    const pool = readPool();
    delete (pool.pool[0] as { assignee?: string }).assignee;
    savePool(pool);
    const r = runCommand(createStatusCommand(), []);
    expect(r.stdout).toContain('未指派');
  });

  it('--assignee 张三 → 目录按负责人分层(保留 unicode)', () => {
    add('T1', 'Add reverse function', ['--assignee', '张三']);
    const t = readPool().pool.find((x) => x.id === 'T1')!;
    expect(t.prd_path).toMatch(/^\.nightowl\/tasks\/张三\//);
    expect(fs.existsSync(path.join(root, t.prd_path!))).toBe(true);
  });

  it('assignee 含路径分隔符 → 安全化', () => {
    add('T1', 'Add reverse', ['--assignee', 'a/b']);
    const t = readPool().pool.find((x) => x.id === 'T1')!;
    expect(t.prd_path).toMatch(/^\.nightowl\/tasks\/a-b\//);
  });

  it('assignee 全空白 → 回退默认层 nightowl-user', () => {
    add('T1', 'Add reverse', ['--assignee', '   ']);
    const t = readPool().pool.find((x) => x.id === 'T1')!;
    expect(t.prd_path).toMatch(/^\.nightowl\/tasks\/nightowl-user\//);
  });
});
