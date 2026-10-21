import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir } from '../src/paths.js';
import { loadPool } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createReviewCommand } from '../src/commands/review.js';
import { createDoneCommand } from '../src/commands/done.js';
import { createNextCommand } from '../src/commands/next.js';
import { backfillPrd } from '../src/prd.js';
import { runCommand } from './helpers.js';
import type { Task } from '../src/state.js';

// PRD 回填必须由 CLI 完成而非 agent 写回:四个平台跑同一份代码,行为逐字节一致。
// 回填边界同样重要 —— 只勾有执行回执的命令,散文验收一律不勾(不制造假绿)。

let root: string;
let prevCwd: string;

function git(args: string[]): string {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-prdbf-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'init.txt'), 'x', 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function addTask(id: string, acceptance: string, verify: string[]): void {
  const args = ['--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '10', '--acceptance', acceptance];
  for (const v of verify) args.push('--verify', v);
  runCommand(createAddCommand(), args);
}

function prdPathOf(id: string): string {
  const pool = loadPool()!;
  return path.resolve(root, pool.pool.find((t) => t.id === id)!.prd_path!);
}

describe('PRD 回填(done 自动,跨平台一致)', () => {
  it('只勾有执行回执的 verify 命令,散文验收保持未勾', () => {
    addTask('T1', '读字节一致;幂等重试', ['true', 'echo ok']);
    runCommand(createNextCommand(), []);
    runCommand(createVerifyCommand(), ['--id', 'T1']);
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'x', 'utf8');
    git(['add', '-A']);
    git(['commit', '-q', '-m', '[#T1] feat']);
    runCommand(createDoneCommand(), ['T1']);

    const prd = fs.readFileSync(prdPathOf('T1'), 'utf8');
    // 有回执的两条命令被勾
    expect(prd).toContain('- [x] `true`');
    expect(prd).toContain('- [x] `echo ok`');
    // 散文验收不勾 —— 无逐条核验证据
    expect(prd).toContain('- [ ] 读字节一致');
    expect(prd).toContain('- [ ] 幂等重试');
  });

  it('状态横幅写清未勾原因,且实现记录填的是事实数据', () => {
    addTask('T2', '验收项甲', ['true']);
    runCommand(createNextCommand(), []);
    runCommand(createVerifyCommand(), ['--id', 'T2']);
    runCommand(createReviewCommand(), ['T2', '--result', 'PASS_WITH_NITS']);
    runCommand(createDoneCommand(), ['T2', '7']);

    const prd = fs.readFileSync(prdPathOf('T2'), 'utf8');
    expect(prd).toContain('> 🤖 nightowl: 任务状态 ✅ done');
    expect(prd).toContain('未勾选条目为自述式验收');
    expect(prd).toContain('实际用时: 7 分');
    expect(prd).toContain('验证: ALL_PASS');
    expect(prd).toContain('审查: PASS_WITH_NITS');
  });

  it('重复 done 幂等:横幅不叠加,内容稳定', () => {
    addTask('T3', '验收', ['true']);
    runCommand(createNextCommand(), []);
    runCommand(createVerifyCommand(), ['--id', 'T3']);
    runCommand(createReviewCommand(), ['T3', '--result', 'PASS']);
    runCommand(createDoneCommand(), ['T3']);
    const first = fs.readFileSync(prdPathOf('T3'), 'utf8');

    // 再次 done 走 alreadyDone 短路,文件不应被改
    runCommand(createDoneCommand(), ['T3']);
    const second = fs.readFileSync(prdPathOf('T3'), 'utf8');
    expect(second).toBe(first);
    // 横幅只有一处
    expect(second.split('> 🤖 nightowl:').length - 1).toBe(1);
  });

  it('backfillPrd 幂等:同一输入连跑两次文件不变', () => {
    const file = path.join(root, 'prd.md');
    const orig = [
      '# t', '', '## Acceptance Criteria', '', '- [ ] 散文', '- [ ] `true`', '',
      '## Implementation Record', '', '<!-- 占位 -->', '',
    ].join('\n');
    fs.writeFileSync(file, orig, 'utf8');
    const task = {
      id: 'TX', title: 't', priority: 'P1', est_min: 5,
      verify_passed: { at: '2026-10-20T00:00:00', commands: ['true'] },
      review: { result: 'PASS', level: 'full', note: '', at: '2026-10-20T00:00:00' },
      status: 'done',
    } as Task;

    const r1 = backfillPrd(file, task, 5, '2026-10-20T01:00:00', null);
    expect(r1.changed).toBe(true);
    expect(r1.checkedCommands).toBe(1);
    const once = fs.readFileSync(file, 'utf8');

    const r2 = backfillPrd(file, task, 5, '2026-10-20T01:00:00', null);
    expect(r2.changed).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  it('PRD 缺失/无验收区时跳过,不影响 done 主流程', () => {
    addTask('T4', '验收', ['true']);
    runCommand(createNextCommand(), []);
    runCommand(createVerifyCommand(), ['--id', 'T4']);
    runCommand(createReviewCommand(), ['T4', '--result', 'PASS']);
    fs.rmSync(prdPathOf('T4'), { force: true });

    const r = runCommand(createDoneCommand(), ['T4']);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).toContain('✅ T4 已标记完成');
  });

  it('回填失败不阻塞 done:只读文件抛错时仍完成任务', () => {
    const task = {
      id: 'TY', title: 't', priority: 'P1', est_min: 5, status: 'done',
      verify_passed: { at: 'x', commands: ['true'] },
      review: { result: 'PASS', level: 'full', note: '', at: 'x' },
    } as Task;
    const r = backfillPrd('/nonexistent/prd.md', task, 5, 'x', null);
    expect(r.skipped).toBe('no-prd');
    expect(r.changed).toBe(false);
  });

  it('非 git 环境:PRD 仍回填,代码版本标注为未绑定', () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-prdbf-nogit-'));
    const prev = process.cwd();
    try {
      process.chdir(noGit);
      setBaseDir(path.join(noGit, '.nightowl'));
      runCommand(createInitCommand(), ['--skip-permissions']);
      const args = ['--id', 'N1', '--title', 't', '--priority', 'P1', '--est-min', '5', '--acceptance', '甲', '--verify', 'true'];
      runCommand(createAddCommand(), args);
      runCommand(createNextCommand(), []);
      runCommand(createVerifyCommand(), ['--id', 'N1']);
      runCommand(createReviewCommand(), ['N1', '--result', 'PASS']);
      runCommand(createDoneCommand(), ['N1']);

      const pool = loadPool()!;
      const prd = fs.readFileSync(path.resolve(noGit, pool.pool.find((t) => t.id === 'N1')!.prd_path!), 'utf8');
      expect(prd).toContain('- [x] `true`');
      expect(prd).toContain('代码版本: 未绑定(非 git 环境');
    } finally {
      process.chdir(prev);
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });
});
