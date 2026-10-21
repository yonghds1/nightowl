import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setBaseDir, pkgRoot } from '../src/paths.js';
import { loadPool, savePool } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createNextCommand } from '../src/commands/next.js';
import { createSweepCommand } from '../src/commands/sweep.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createPushCommand } from '../src/commands/push.js';
import { createWorktreeCommand } from '../src/commands/worktree.js';
import { createCheckpointCommand } from '../src/commands/checkpoint.js';
import { createSelfcheckCommand } from '../src/commands/selfcheck.js';
import { runCommand } from './helpers.js';

/**
 * 机器协议契约。
 *
 * 调度循环(技能 + 斜杠命令)靠这些 token 做分支判断,而不是靠自然语言。
 * 所以 token 改名 = 技能静默失效,但 typecheck 和既有测试都不会报错。
 * 这里双向锁死:
 *   正向 —— 每个 token 都有真实场景产出(证明发得出来);
 *   反向 —— 文档/技能里出现的每个全大写 token 都必须登记在册(防止单边改名)。
 */

/** 协议 token 域:命令/文件 → 它对外承诺的全部 token。改这里 = 改协议。 */
const PROTOCOL = {
  next: [
    'NO_TASK',
    'WORKTREE_ROOT:',
    'PRD_PATH:',
    'DESCRIPTION:',
    'ACCEPTANCE:',
    'VERIFY:',
    'RESUME',
    'RESUME_MERGE',
    'RESUME_COMMITTED',
  ],
  sweep: [
    'SWEEP_CLEAN',
    'SWEEP_FAIL:',
    'SWEEP_REMOVED:',
    'SWEEP_KEEP_UNMERGED:',
    'SWEEP_KEEP_DIRTY:',
    'SWEEP_KEEP_UNKNOWN:',
    'SWEEP_REMOVE_FAIL:',
    'SWEEP_KEEP_LOCKED:',
    'SWEEP_BASE:',
  ],
  commit: ['COMMIT_OK', 'COMMIT_FAIL'],
  verify: ['ALL_PASS', 'VERIFY_NONE', 'ERROR:'],
  // INVALID_TASK_ID 由 task-id.ts 抛错、由各命令 catch 后打印,登记在 taskId 域

  push: [
    'PUSH_OK',
    'PUSH_NOTHING',
    'PUSH_SKIPPED_NO_REMOTE',
    'PUSH_SKIPPED_NO_GIT',
    'PUSH_FAIL',
    'PUSH_DETACHED',
    'PUSH_NO_REMOTE_SELECTED',
    'PUSH_REJECTED',
  ],
  worktree: [
    'WORKTREE_READY:',
    'WORKTREE_EXISTS:',
    'WORKTREE_SKIPPED:',
    'WORKTREE_MERGED:',
    'WORKTREE_MERGE_SKIPPED:',
    'WORKTREE_CLEANED:',
    'WORKTREE_CLEAN_SKIPPED:',
    'WORKTREE_EMPTY',
    'WORKTREE_DIRTY:',
    'WORKTREE_MERGE_FAIL:',
    'WORKTREE_SETUP_FAIL:',
    'WORKTREE_CLEANUP_FAIL:',
    'WORKTREE_LIST_FAIL:',
    'VERIFY_RECORD_STALE:',
    'WORKTREE_DETACHED:',
    'WORKTREE_MERGE_IN_PROGRESS:',
    'WORKTREE_MERGE_DIRTY:',
    'WORKTREE_MERGE_CONFLICT:',
    'WORKTREE_MERGE_RECHECK_FAIL:',
  ],
  preflight: ['PREFLIGHT_OK', 'PREFLIGHT_FAIL:'],
  checkpoint: ['CHECKPOINT_NONE', 'CHECKPOINT_DONE', 'CHECKPOINT_EXISTS:'],
  selfcheck: ['PERMISSION_MODE:'],
  taskId: ['INVALID_TASK_ID:'],
} as const;

const ALL_TOKENS: string[] = Object.values(PROTOCOL).flat();

/**
 * 技能正文里允许出现的非协议全大写词。
 * 只放"人读的词",不放"机器读的 token"——新 token 若不登记进 PROTOCOL,
 * 落在这张表外,反向检查就会红。
 */
const NON_PROTOCOL_WORDS = [
  'ABCD', // plan 技能里"不要问卷调查式 ABCD 选项"
  'CODE', // SKILL.md / 代码 的泛指
  'HEAD', // git rev-parse HEAD
  'LICENSE',
  'README',
  'REVIEW',
  'SKILL',
  'YAML',
  'PASS', // review --result PASS,业务取值不是协议 token
  'NIGHTOWL_LANG',
  'PLATFORM_', // 模板变量前缀,由 skills.test.ts 单独校验
  'PLATFORM_ASK',
  'PLATFORM_HEADLESS',
  'PLATFORM_PUSH_MODE',
  'PLATFORM_RELAUNCH',
  'PLATFORM_SUBAGENT_CALL',
  'PLATFORM_SUBAGENT_D',
  'PLATFORM_SUBAGENT_DIR',
];

let root: string;
let prevCwd: string;

function git(args: string[], cwd: string = root): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-proto-'));
  prevCwd = process.cwd();
  process.chdir(root);
  setBaseDir(path.join(root, '.nightowl'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 't']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

function addTask(id: string, extra: string[] = []): void {
  runCommand(createAddCommand(), [
    '--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '15', ...extra,
  ]);
}

function docsText(): string {
  const files: string[] = [];
  const skillsDir = path.join(pkgRoot(), 'skills');
  const cmdDir = path.join(pkgRoot(), 'templates', 'commands', 'nightowl');
  for (const d of fs.readdirSync(skillsDir)) {
    const f = path.join(skillsDir, d, 'SKILL.md');
    if (fs.existsSync(f)) files.push(f);
  }
  for (const f of fs.readdirSync(cmdDir)) files.push(path.join(cmdDir, f));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

/** 抽出文档里的全大写 token(≥4 字符,允许尾随冒号)。 */
function docTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})(:)?/g)) {
    out.add(m[1] + (m[2] ?? ''));
  }
  return out;
}

describe('协议登记表自检', () => {
  it('token 不跨域重复(同名 token 只能属于一个命令)', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [domain, list] of Object.entries(PROTOCOL)) {
      for (const tok of list) {
        const prev = seen.get(tok);
        if (prev) dup.push(`${tok} (${prev} / ${domain})`);
        seen.set(tok, domain);
      }
    }
    expect(dup).toEqual([]);
  });

  it('token 格式合法:全大写+数字+下划线,冒号只在结尾', () => {
    const bad = ALL_TOKENS.filter((t) => !/^[A-Z][A-Z0-9_]*:?$/.test(t));
    expect(bad).toEqual([]);
  });
});

describe('反向:文档里出现的 token 必须已登记', () => {
  it('skills/ + 斜杠命令模板里的全大写 token ⊆ PROTOCOL ∪ 非协议词表', () => {
    const allowed = new Set<string>([...ALL_TOKENS, ...NON_PROTOCOL_WORDS]);
    const unknown = [...docTokens(docsText())]
      .filter((t) => !allowed.has(t))
      // PLATFORM_ 前缀是模板变量族,逐个列在 NON_PROTOCOL_WORDS 之外单独放行
      .filter((t) => !t.startsWith('PLATFORM_'))
      .sort();
    expect(
      unknown,
      `技能/命令文档里出现了未登记的协议 token: ${unknown.join(', ')}。\n` +
        '若这是新协议,登记进本文件 PROTOCOL;若只是人读的词,加进 NON_PROTOCOL_WORDS。',
    ).toEqual([]);
  });

  it('src 里发出的 token 都在登记表内(防止新增 token 未进契约)', () => {
    const pat = /console\.(?:log|error)\(\s*[`'"]([A-Z][A-Z0-9_]*)(:?)/g;
    const emitted = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(pat)) emitted.add(m[1] + m[2]);
        }
      }
    };
    walk(path.join(pkgRoot(), 'src'));
    // RESUME in_progress 是以 `# RESUME` 开头的模板字符串,正则抓不到,手工补登
    emitted.delete('RESUME');
    const unregistered = [...emitted].filter((t) => !ALL_TOKENS.includes(t as never)).sort();
    expect(unregistered).toEqual([]);
  });
});

describe('正向:每个 token 都能真实产出', () => {
  it('next:NO_TASK(空池)', () => {
    expect(runCommand(createNextCommand(), []).stdout).toContain('NO_TASK');
  });

  it('next:任务块全套字段', () => {
    addTask('T1', [
      '--desc', '实现反转函数',
      '--acceptance', '空串返回空',
      '--verify', 'true',
    ]);
    const r = runCommand(createNextCommand(), []);
    for (const tok of ['WORKTREE_ROOT:', 'PRD_PATH:', 'DESCRIPTION:', 'ACCEPTANCE:', 'VERIFY:']) {
      expect(r.stdout, `缺少协议字段 ${tok}`).toContain(tok);
    }
  });

  it('next:RESUME 三个分支(崩溃续跑幂等)', () => {
    addTask('T1');

    // ① in_progress 但没有任何 commit
    runCommand(createNextCommand(), []);
    expect(runCommand(createNextCommand(), []).stdout).toContain('# RESUME in_progress T1');

    // ② 有未合入 commit
    git(['checkout', '-q', '-b', 'wt-t1']);
    fs.writeFileSync(path.join(root, 'impl.txt'), 'work', 'utf8');
    git(['add', 'impl.txt']);
    git(['commit', '-q', '-m', '[#T1] impl']);
    git(['checkout', '-q', '-']);
    expect(runCommand(createNextCommand(), []).stdout).toContain('# RESUME_MERGE T1');

    // ③ 已合入当前分支
    git(['merge', '-q', '--no-ff', '-m', 'merge [#T1]', 'wt-t1']);
    expect(runCommand(createNextCommand(), []).stdout).toContain('# RESUME_COMMITTED T1');
  });

  it('sweep --clean:安全清理 token', () => {
    // 已合入且干净 → SWEEP_REMOVED;未合入 → SWEEP_KEEP_UNMERGED
    addTask('TC1');
    runCommand(createWorktreeCommand(), ['setup', 'TC1']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'TC1');
    fs.writeFileSync(path.join(wt, 'impl.txt'), 'w', 'utf8');
    spawnSync('git', ['-C', wt, 'add', 'impl.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', '[#TC1] impl'], { encoding: 'utf8' });
    git(['merge', '-q', '--no-ff', '-m', 'merge [#TC1]', 'nightowl/TC1']);

    const r = runCommand(createSweepCommand(), ['--clean']);
    expect(r.stdout).toContain('SWEEP_REMOVED:');
    expect(fs.existsSync(wt)).toBe(false);

    // 未合入 = 分支上有 main 没有的 commit;只是 setup 出来还没提交的会被当干净残留删掉
    addTask('TC2');
    runCommand(createWorktreeCommand(), ['setup', 'TC2']);
    const wt2 = path.join(root, '.nightowl', 'worktrees', 'TC2');
    fs.writeFileSync(path.join(wt2, 'wip.txt'), 'w', 'utf8');
    spawnSync('git', ['-C', wt2, 'add', 'wip.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt2, 'commit', '-q', '-m', '[#TC2] wip'], { encoding: 'utf8' });
    const r2 = runCommand(createSweepCommand(), ['--clean']);
    expect(r2.stdout).toContain('SWEEP_KEEP_UNMERGED:');
    expect(fs.existsSync(wt2)).toBe(true);
  });

  it('sweep:SWEEP_CLEAN 与残留报告', () => {
    expect(runCommand(createSweepCommand(), []).stdout).toContain('SWEEP_CLEAN');

    runCommand(createWorktreeCommand(), ['setup', 'T1']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'T1');
    fs.writeFileSync(path.join(wt, 'impl.txt'), 'work', 'utf8');
    spawnSync('git', ['-C', wt, 'add', 'impl.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', '[#T1] impl'], { encoding: 'utf8' });

    const r = runCommand(createSweepCommand(), []);
    expect(r.stdout).not.toContain('SWEEP_CLEAN');
    expect(r.stdout).toContain('nightowl/T1');
  });

  it('verify:VERIFY_NONE / ALL_PASS / ERROR:', () => {
    addTask('T1');
    expect(runCommand(createVerifyCommand(), ['T1']).stdout).toContain('VERIFY_NONE');

    addTask('T2', ['--verify', 'true']);
    expect(runCommand(createVerifyCommand(), ['T2']).stdout).toContain('ALL_PASS');

    const r = runCommand(createVerifyCommand(), []);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('ERROR:');
  });

  it('push:无 remote → PUSH_SKIPPED_NO_REMOTE', () => {
    expect(runCommand(createPushCommand(), []).stdout).toContain('PUSH_SKIPPED_NO_REMOTE');
  });

  it('worktree:READY / EXISTS / MERGED / CLEANED / EMPTY', () => {
    addTask('T1');
    expect(runCommand(createWorktreeCommand(), ['list']).stdout).toContain('WORKTREE_EMPTY');
    expect(runCommand(createWorktreeCommand(), ['setup', 'T1']).stdout).toContain('WORKTREE_READY:');

    const again = runCommand(createWorktreeCommand(), ['setup', 'T1']);
    expect(again.exitCode).toBe(1);
    expect(again.output).toContain('WORKTREE_EXISTS:');

    const wt = path.join(root, '.nightowl', 'worktrees', 'T1');
    fs.writeFileSync(path.join(wt, 'impl.txt'), 'work', 'utf8');
    spawnSync('git', ['-C', wt, 'add', 'impl.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', '[#T1] impl'], { encoding: 'utf8' });

    expect(runCommand(createWorktreeCommand(), ['merge', 'T1']).stdout).toContain('WORKTREE_MERGED:');
    expect(runCommand(createWorktreeCommand(), ['cleanup', 'T1']).stdout).toContain('WORKTREE_CLEANED:');
  });

  it('worktree:DIRTY / MERGE_FAIL / VERIFY_RECORD_STALE', () => {
    addTask('T1', ['--verify', 'true']);
    runCommand(createWorktreeCommand(), ['setup', 'T1']);
    const wt = path.join(root, '.nightowl', 'worktrees', 'T1');
    fs.writeFileSync(path.join(wt, 'impl.txt'), 'work', 'utf8');
    spawnSync('git', ['-C', wt, 'add', 'impl.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', '[#T1] impl'], { encoding: 'utf8' });

    // 未提交改动 → DIRTY 并保留现场
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'wip', 'utf8');
    const dirty = runCommand(createWorktreeCommand(), ['cleanup', 'T1']);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.output).toContain('WORKTREE_DIRTY:');

    // 验证后再改 → STALE
    spawnSync('git', ['-C', wt, 'add', 'wip.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', '[#T1] wip'], { encoding: 'utf8' });
    runCommand(createVerifyCommand(), ['T1']);
    fs.writeFileSync(path.join(wt, 'more.txt'), 'more', 'utf8');
    spawnSync('git', ['-C', wt, 'add', 'more.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt, 'commit', '-q', '-m', '[#T1] more'], { encoding: 'utf8' });
    const stale = runCommand(createWorktreeCommand(), ['merge', 'T1']);
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain('VERIFY_RECORD_STALE:');

    // 缺 [#id] 标记 → MERGE_FAIL
    addTask('T2');
    runCommand(createWorktreeCommand(), ['setup', 'T2']);
    const wt2 = path.join(root, '.nightowl', 'worktrees', 'T2');
    fs.writeFileSync(path.join(wt2, 'impl.txt'), 'work', 'utf8');
    spawnSync('git', ['-C', wt2, 'add', 'impl.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', wt2, 'commit', '-q', '-m', 'no tag'], { encoding: 'utf8' });
    const bad = runCommand(createWorktreeCommand(), ['merge', 'T2']);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('WORKTREE_MERGE_FAIL:');
  });

  it('checkpoint:NONE / EXISTS / DONE', () => {
    expect(runCommand(createCheckpointCommand(), ['status']).stdout).toContain('CHECKPOINT_NONE');
    addTask('T1');
    runCommand(createCheckpointCommand(), ['save']);
    expect(runCommand(createCheckpointCommand(), ['status']).stdout).toContain('CHECKPOINT_EXISTS:');

    const pool = loadPool()!;
    pool.pool = [];
    savePool(pool);
    runCommand(createCheckpointCommand(), ['save']);
    expect(runCommand(createCheckpointCommand(), ['status']).stdout).toContain('CHECKPOINT_DONE');
  });

  it('selfcheck:PERMISSION_MODE 有明确取值(不留空)', () => {
    const r = runCommand(createSelfcheckCommand(), []);
    expect(r.stdout).toMatch(/PERMISSION_MODE: (bypass|not_bypass|unknown)/);
  });

  it('taskId:非法 id 触发 INVALID_TASK_ID,且不泄漏 Node 调用栈', () => {
    // 曾未捕获 assertTaskId 抛错 → 11 行栈打到 stderr。机器协议接口不该出现栈。
    for (const args of [['setup', '../escape'], ['merge', '../escape'], ['cleanup', '../escape']]) {
      const r = runCommand(createWorktreeCommand(), args);
      expect(r.exitCode, `worktree ${args[0]} 应退出 1`).toBe(1);
      expect(r.output).toContain('INVALID_TASK_ID:');
      expect(r.output, `worktree ${args[0]} 泄漏了调用栈`).not.toContain('at assertTaskId');
      expect(r.output).not.toContain('    at ');
    }

    const v = runCommand(createVerifyCommand(), ['../escape']);
    expect(v.exitCode).toBe(1);
    expect(v.output).toContain('INVALID_TASK_ID:');
    expect(v.output).not.toContain('at assertTaskId');
  });
});
