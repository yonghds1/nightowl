import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { loadPool, loadState, savePool, saveState } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createReportCommand } from '../src/commands/report.js';
import { noteFreshness } from '../src/report-freshness.js';
import { runCommand } from './helpers.js';

// 报告里的 Review.note 是审查当时写的原文,不会随状态变化重算。
// 实测事故:M5 的备注写"M6 仍需完成",M6 后来已完成,报告却原样照搬。
// 修法不是改写原文(等于伪造审查记录),而是追加时效后缀。

describe('noteFreshness 纯函数', () => {
  const allIds = ['M5', 'M6', 'M7', 'T1', 'T10'];

  it('提及的任务此后已完成 → 标注「此后已完成」', () => {
    const r = noteFreshness('M6 仍需完成才能收尾', allIds, new Set(['M5', 'M6']));
    expect(r.suffix).toBe('〔时效:M6 此后已完成〕');
    expect(r.completedIds).toEqual(['M6']);
    expect(r.pendingIds).toEqual([]);
  });

  it('提及的任务仍未完成 → 标注「仍未完成」', () => {
    const r = noteFreshness('依赖 M7 收尾', allIds, new Set(['M5']));
    expect(r.suffix).toBe('〔时效:M7 仍未完成〕');
  });

  it('混合情况两段都标', () => {
    const r = noteFreshness('M6 已完成但 M7 待做', allIds, new Set(['M6']));
    expect(r.suffix).toBe('〔时效:M6 此后已完成;M7 仍未完成〕');
  });

  it('未提及任何任务 id → 不加后缀(不噪声)', () => {
    expect(noteFreshness('代码质量良好,命名清晰', allIds, new Set()).suffix).toBeNull();
    expect(noteFreshness('', allIds, new Set()).suffix).toBeNull();
  });

  it('id 边界匹配:不把 T1 误判进 T10', () => {
    const r = noteFreshness('T10 尚未开始', allIds, new Set(['T1']));
    expect(r.completedIds).toEqual([]);
    expect(r.pendingIds).toEqual(['T10']);
  });

  it('id 出现在句中(前后有标点)也能匹配', () => {
    const r = noteFreshness('(M6) 还要改', allIds, new Set(['M6']));
    expect(r.completedIds).toEqual(['M6']);
  });
});

describe('报告输出体现时效', () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-fresh-'));
    prevCwd = process.cwd();
    process.chdir(root);
    setBaseDir(path.join(root, '.nightowl'));
    runCommand(createInitCommand(), ['--skip-permissions']);
    for (const id of ['M5', 'M6']) {
      runCommand(createAddCommand(), ['--id', id, '--title', `task ${id}`, '--priority', 'P1', '--est-min', '10']);
    }
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('旧备注提到的任务完成后,报告里出现时效标注而原文保留', () => {
    const pool = loadPool()!;
    const state = loadState();
    // M5 审查时写的静态判断
    pool.pool.find((t) => t.id === 'M5')!.review = {
      result: 'PASS', level: 'full', note: 'M6 仍需完成', at: '2026-10-20T10:00:00',
    };
    savePool(pool);
    // 之后 M5、M6 都完成了
    state.completed = [
      { id: 'M5', actual_min: 10, finished_at: '2026-10-20T11:00:00' },
      { id: 'M6', actual_min: 12, finished_at: '2026-10-20T12:00:00' },
    ];
    saveState(state);

    const r = runCommand(createReportCommand(), []);
    // 原文保留(不篡改审查记录)
    expect(r.output).toContain('M6 仍需完成');
    // 并追加时效说明
    expect(r.output).toContain('〔时效:M6 此后已完成〕');
  });

  it('备注提到的任务仍未完成时不误标已完成', () => {
    const pool = loadPool()!;
    const state = loadState();
    pool.pool.find((t) => t.id === 'M5')!.review = {
      result: 'PASS', level: 'full', note: 'M6 仍需完成', at: '2026-10-20T10:00:00',
    };
    savePool(pool);
    state.completed = [{ id: 'M5', actual_min: 10, finished_at: '2026-10-20T11:00:00' }];
    saveState(state);

    const r = runCommand(createReportCommand(), []);
    expect(r.output).toContain('〔时效:M6 仍未完成〕');
    expect(r.output).not.toContain('M6 此后已完成');
  });
});
