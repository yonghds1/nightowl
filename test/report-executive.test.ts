import { describe, it, expect } from 'vitest';
import { buildExecutiveSummary, groupGitByTask } from '../src/commands/report.js';
import { Pool, AppState } from '../src/state.js';

describe('Executive Summary 与 Git 聚合分析', () => {
  it('全通过时给出 READY 判定并计算工时偏差', () => {
    const pool: Pool = {
      schedule: { retry_budget: 3 },
      pool: [
        { id: 'T1', title: 'Task 1', priority: 'P0', est_min: 30, depends_on: [], status: 'completed' },
        { id: 'T2', title: 'Task 2', priority: 'P1', est_min: 60, depends_on: [], status: 'completed' },
      ],
    };
    const state: AppState = {
      current: null,
      completed: [
        { id: 'T1', actual_min: 30 },
        { id: 'T2', actual_min: 75 },
      ],
      blocked: [],
      history: [],
      created: '',
      last_run: '',
    };

    const summary = buildExecutiveSummary(pool, state);
    expect(summary.verdict).toBe('READY'); // 偏差率 (105-90)/90 = 16.6% <= 30%
    expect(summary.done).toBe(2);
    expect(summary.blocked).toBe(0);
    expect(summary.p0Done).toBe(1);
    expect(summary.totalEst).toBe(90);
    expect(summary.totalActual).toBe(105);
  });

  it('存在阻塞任务或 P0 未完成时给出 BLOCKED 判定', () => {
    const pool: Pool = {
      schedule: { retry_budget: 3 },
      pool: [
        { id: 'T1', title: 'Task 1', priority: 'P0', est_min: 30, depends_on: [], status: 'pending' },
      ],
    };
    const state: AppState = {
      current: null,
      completed: [],
      blocked: [{ id: 'T2', reason: 'Blocked by env' }],
      history: [],
      created: '',
      last_run: '',
    };

    const summary = buildExecutiveSummary(pool, state);
    expect(summary.verdict).toBe('BLOCKED');
  });

  it('groupGitByTask 按 [#id] 分组提取 commit', () => {
    const gitlog = `
9a68063 feat(core): [#T1] add native worktree
41cce73 docs: [#T1] update docs
02f8741 feat: [#T2] implement verify
f5d96c1 chore: release 0.4.2
    `.trim();

    const grouped = groupGitByTask(gitlog);
    expect(grouped.has('[#T1]')).toBe(true);
    expect(grouped.get('[#T1]')!.length).toBe(2);
    expect(grouped.has('[#T2]')).toBe(true);
    expect(grouped.get('[#T2]')!.length).toBe(1);
    expect(grouped.has('其他变更')).toBe(true);
    expect(grouped.get('其他变更')!.length).toBe(1);
  });
});
