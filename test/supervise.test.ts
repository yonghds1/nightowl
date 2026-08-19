import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { loadState, saveState, loadPool } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createScheduleCommand } from '../src/commands/schedule.js';
import {
  progressSig,
  backoffSec,
  shouldStopIdle,
  rotateLogIfLarge,
  superviseLoop,
  blockInProgress,
  type SuperviseOptions,
} from '../src/commands/supervise.js';
import type { HeadlessRun } from '../src/platforms/types.js';
import { runCommand, captureConsole } from './helpers.js';

let root: string;
let stateFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-sup-'));
  setBaseDir(path.join(root, '.nightowl'));
  stateFile = path.join(root, '.nightowl', 'nightowl.state.yaml');
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function addTask(id: string, deps: string[] = []): void {
  const args = ['--id', id, '--title', `Task ${id}`, '--priority', 'P0', '--est-min', '15'];
  for (const d of deps) args.push('--depends-on', d);
  runCommand(createAddCommand(), args);
}

function baseOpts(p: Partial<SuperviseOptions> = {}): SuperviseOptions {
  return { intervalSec: 0, timeoutMin: 1, maxIdle: 3, once: false, ...p };
}

/** fake host:每轮把 in_progress 任务移到 completed(模拟主会话 next→实现→done)。 */
function advancingHost(): HeadlessRun {
  const script = `
    const fs = require('fs');
    const yaml = require('js-yaml');
    const p = ${JSON.stringify(stateFile)};
    const s = yaml.load(fs.readFileSync(p, 'utf8'));
    const ip = s.in_progress;
    if (ip && ip.id) {
      s.completed.push({ id: ip.id, actual_min: 1, finished_at: new Date().toISOString() });
      s.in_progress = null;
      fs.writeFileSync(p, yaml.dump(s, { noRefs: true }));
    }
  `;
  return { cmd: 'node', args: () => ['-e', script] };
}

const noopHost: HeadlessRun = { cmd: 'node', args: () => ['-e', ''] };
const failHost: HeadlessRun = { cmd: 'node', args: () => ['-e', 'process.exit(3)'] };

describe('纯函数', () => {
  it('progressSig = completed:blocked 数量', () => {
    const s = {
      completed: [{ id: 'T1', actual_min: 1, finished_at: 'x' }],
      blocked: [{ id: 'T2', reason: 'r', blocked_at: 'x' }],
      in_progress: null,
    };
    expect(progressSig(s)).toBe('1:1');
    expect(progressSig({ completed: [], blocked: [], in_progress: null })).toBe('0:0');
  });

  it('backoffSec 指数退避,上限 60', () => {
    expect(backoffSec(0)).toBe(1);
    expect(backoffSec(1)).toBe(2);
    expect(backoffSec(2)).toBe(4);
    expect(backoffSec(6)).toBe(60);
    expect(backoffSec(10)).toBe(60);
  });

  it('shouldStopIdle:达到上限才停', () => {
    expect(shouldStopIdle(2, 3)).toBe(false);
    expect(shouldStopIdle(3, 3)).toBe(true);
  });

  it('rotateLogIfLarge:超阈值改名 .1 重开', () => {
    const logPath = path.join(root, '.nightowl', 'nightowl.supervisor.log');
    fs.writeFileSync(logPath, 'x'.repeat(11), 'utf8');
    rotateLogIfLarge(logPath, 10);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
  });

  it('rotateLogIfLarge:未超阈值不动', () => {
    const logPath = path.join(root, '.nightowl', 'nightowl.supervisor.log');
    fs.writeFileSync(logPath, 'x'.repeat(5), 'utf8');
    rotateLogIfLarge(logPath, 10);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });
});

describe('blockInProgress', () => {
  it('阻塞指定任务:同步 pool status + state + checkpoint', () => {
    addTask('T1');
    const s = loadState();
    s.in_progress = { id: 'T1', started_at: 'x' };
    saveState(s);
    blockInProgress(loadState(), 'T1', '会话失败');
    const after = loadState();
    expect(after.blocked.map((b) => b.id)).toContain('T1');
    expect(after.blocked[0].reason).toBe('会话失败');
    expect(after.in_progress).toBeNull();
    expect(loadPool()!.pool.find((t) => t.id === 'T1')!.status).toBe('blocked');
    expect(fs.existsSync(path.join(root, '.nightowl', 'nightowl.checkpoint.yaml'))).toBe(true);
  });

  it('block 指定 id 不影响其它 in_progress(保留主会话 next 出的新任务)', () => {
    addTask('T1');
    addTask('T2');
    const s = loadState();
    s.in_progress = { id: 'T2', started_at: 'x' };
    saveState(s);
    blockInProgress(loadState(), 'T1', '会话失败');
    const after = loadState();
    expect(after.in_progress!.id).toBe('T2');
    expect(after.blocked.map((b) => b.id)).toContain('T1');
  });
});

describe('superviseLoop 循环', () => {
  it('任务池全部完成后退出 0', async () => {
    addTask('T1');
    addTask('T2');
    addTask('T3');
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), advancingHost());
    expect(code).toBe(0);
    expect(loadState().completed).toHaveLength(3);
    expect(captured.logs.join('\n')).toContain('run 完成');
    // 每轮推进一个任务:3 个任务 → 至少 3 轮
    expect(logs.filter((l) => l.includes('第') && l.includes('轮'))).toHaveLength(3);
  });

  it('选中任务设置 in_progress(崩溃续跑语义)', async () => {
    addTask('T1');
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), advancingHost());
    expect(code).toBe(0);
    expect(loadState().in_progress).toBeNull();
    expect(loadState().completed.map((c) => c.id)).toContain('T1');
  });

  it('连续空转达到 --max-idle 停止', async () => {
    addTask('T1');
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts({ maxIdle: 2 }), (l) => logs.push(l), noopHost);
    expect(code).toBe(0);
    expect(captured.logs.join('\n')).toContain('无进展');
    expect(loadState().completed).toHaveLength(0);
    // 第一轮记 idle,第二轮达上限直接停(打 idleStop,不再打 idle)
    expect(logs.filter((l) => l.includes('本轮无进展'))).toHaveLength(1);
    expect(captured.logs.join('\n')).toContain('连续 2 轮无进展');
  });

  it('--once 只跑一轮就退出', async () => {
    addTask('T1');
    addTask('T2');
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts({ once: true }), (l) => logs.push(l), advancingHost());
    expect(code).toBe(0);
    expect(captured.logs.join('\n')).toContain('--once');
    expect(loadState().completed).toHaveLength(1);
  });

  it('retry 耗尽阻塞任务(有阻塞退出码 1)', async () => {
    addTask('T1');
    runCommand(createScheduleCommand(), ['--retry-budget', '1']);
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), failHost);
    expect(code).toBe(1);
    expect(loadState().blocked.map((b) => b.id)).toContain('T1');
    expect(loadPool()!.pool.find((t) => t.id === 'T1')!.status).toBe('blocked');
    expect(loadState().blocked[0].reason).toContain('会话失败');
    expect(logs.join('\n')).toContain('阻塞任务');
    // done 消息区分阻塞(非"全绿")
    expect(captured.logs.join('\n')).toContain('含 1 个阻塞');
  });

  it('失败但有进展不累计失败(不误阻塞 next 出的新任务)', async () => {
    addTask('T1');
    addTask('T2');
    runCommand(createScheduleCommand(), ['--retry-budget', '1']);
    // fake host:每轮先完成 in_progress,再以非 0 退出(模拟超时前完成了任务)
    const script = `
      const fs = require('fs');
      const yaml = require('js-yaml');
      const p = ${JSON.stringify(stateFile)};
      const s = yaml.load(fs.readFileSync(p, 'utf8'));
      const ip = s.in_progress;
      if (ip && ip.id) {
        s.completed.push({ id: ip.id, actual_min: 1, finished_at: new Date().toISOString() });
        s.in_progress = null;
        fs.writeFileSync(p, yaml.dump(s, { noRefs: true }));
      }
      process.exit(3);
    `;
    const host: HeadlessRun = { cmd: 'node', args: () => ['-e', script] };
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), host);
    expect(code).toBe(0); // 无 blocked → 0
    expect(loadState().completed).toHaveLength(2);
    expect(loadState().blocked).toHaveLength(0);
  });

  it('超时强制结束本轮并计失败', async () => {
    addTask('T1');
    runCommand(createScheduleCommand(), ['--retry-budget', '1']);
    // fake host 挂起 5s;supervise 用 0.001min(60ms)超时 kill
    const hangHost: HeadlessRun = { cmd: 'node', args: () => ['-e', 'setTimeout(() => {}, 5000)'] };
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts({ timeoutMin: 0.001 }), (l) => logs.push(l), hangHost);
    expect(code).toBe(1);
    expect(loadState().blocked.map((b) => b.id)).toContain('T1');
    expect(logs.join('\n')).toContain('超时');
  });

  it('无 headlessRun 的平台报错退出 1', async () => {
    fs.writeFileSync(path.join(root, '.nightowl', '.platform'), 'codex', 'utf8');
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l));
    expect(code).toBe(1);
    expect(captured.errs.join('\n')).toContain('headlessRun 未实现');
  });

  it('业务任务耗尽但 report 未落盘:退出前拉起收尾轮', async () => {
    addTask('T1');
    const reportFile = path.join(root, '.nightowl', 'nightowl.report.md');
    // fake host:有 in_progress → 完成之(推进轮);无(收尾轮)→ 生成 report
    const script = `
      const fs = require('fs');
      const yaml = require('js-yaml');
      const p = ${JSON.stringify(stateFile)};
      const s = yaml.load(fs.readFileSync(p, 'utf8'));
      if (s.in_progress && s.in_progress.id) {
        s.completed.push({ id: s.in_progress.id, actual_min: 1, finished_at: new Date().toISOString() });
        s.in_progress = null;
        fs.writeFileSync(p, yaml.dump(s, { noRefs: true }));
      } else {
        fs.writeFileSync(${JSON.stringify(reportFile)}, '# report', 'utf8');
      }
    `;
    const host: HeadlessRun = { cmd: 'node', args: () => ['-e', script] };
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), host);
    expect(code).toBe(0);
    expect(fs.existsSync(reportFile)).toBe(true);
    expect(logs.join('\n')).toContain('收尾轮');
  });

  it('report 已由主会话生成:不再拉起收尾轮直接退出', async () => {
    addTask('T1');
    fs.writeFileSync(path.join(root, '.nightowl', 'nightowl.report.md'), '# report', 'utf8');
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), advancingHost());
    expect(code).toBe(0);
    expect(loadState().completed.map((c) => c.id)).toContain('T1');
    expect(logs.join('\n')).not.toContain('收尾轮');
  });

  it('空池(未跑过任务)不拉起收尾轮', async () => {
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), noopHost);
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('收尾轮');
  });

  it('剩余任务依赖未满足(卡死)退出 1,不谎称 run 完成', async () => {
    addTask('T1', ['T2']);
    addTask('T2');
    const s = loadState();
    s.blocked.push({ id: 'T2', reason: 'r', blocked_at: 'x' });
    saveState(s);
    const captured = captureConsole();
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), noopHost);
    expect(code).toBe(1);
    expect(captured.errs.join('\n')).toContain('依赖未满足');
    expect(captured.logs.join('\n')).not.toContain('run 完成');
  });

  it('--continue 快速失败时回退去掉 --continue 再跑一轮', async () => {
    addTask('T1');
    // 预生成 report 跳过收尾轮,保证只测 fallback 分支的两次 spawn
    fs.writeFileSync(path.join(root, '.nightowl', 'nightowl.report.md'), '# report', 'utf8');
    const calls: boolean[] = [];
    const script = (useContinue: boolean) => `
      const fs = require('fs');
      const yaml = require('js-yaml');
      const p = ${JSON.stringify(stateFile)};
      if (${useContinue}) process.exit(1);
      const s = yaml.load(fs.readFileSync(p, 'utf8'));
      if (s.in_progress && s.in_progress.id) {
        s.completed.push({ id: s.in_progress.id, actual_min: 1, finished_at: new Date().toISOString() });
        s.in_progress = null;
        fs.writeFileSync(p, yaml.dump(s, { noRefs: true }));
      }
    `;
    const host: HeadlessRun = {
      cmd: 'node',
      args: (_p: string, useContinue: boolean) => {
        calls.push(useContinue);
        return ['-e', script(useContinue)];
      },
    };
    const logs: string[] = [];
    const code = await superviseLoop(baseOpts(), (l) => logs.push(l), host);
    expect(code).toBe(0);
    expect(calls).toEqual([true, false]);
    expect(loadState().completed.map((c) => c.id)).toContain('T1');
    expect(logs.join('\n')).toContain('回退');
  });
});
