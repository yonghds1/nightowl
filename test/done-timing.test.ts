import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { savePool, saveState, loadState, loadPool, type Pool } from '../src/state.js';
import { createDoneCommand } from '../src/commands/done.js';
import { isoOf } from '../src/util.js';
import { runCommand } from './helpers.js';

let root: string;

function poolFixture(): Pool {
  return {
    schedule: { retry_budget: 1 },
    checkpoint: { enabled: false, write_every: 1 },
    pool: [
      { id: 'T1', title: 'Task 1', priority: 'P1', est_min: 10, depends_on: [], status: 'pending' },
      { id: 'T2', title: 'Task 2', priority: 'P1', est_min: 45, depends_on: [], status: 'pending' },
    ],
  };
}

function seed(startedAt?: string): void {
  savePool(poolFixture());
  saveState({
    completed: [],
    blocked: [],
    in_progress: startedAt ? { id: 'T1', started_at: startedAt } : null,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-timing-'));
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('done 的实际用时', () => {
  it('无参数时按 in_progress.started_at 实测,而不是等于预估', () => {
    seed(isoOf(new Date(Date.now() - 25 * 60_000)));
    const r = runCommand(createDoneCommand(), ['T1', '--force']);
    expect(r.exitCode).toBeUndefined();

    const state = loadState();
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0].actual_min).toBeGreaterThanOrEqual(24);
    expect(state.completed[0].actual_min).toBeLessThanOrEqual(26);
    expect(state.completed[0].actual_min).not.toBe(10); // 不是 est_min
    expect(loadPool()!.pool[0].actual_min).toBe(state.completed[0].actual_min);
  });

  it('显式传入的分钟数优先', () => {
    seed(isoOf(new Date(Date.now() - 25 * 60_000)));
    runCommand(createDoneCommand(), ['T1', '7', '--force']);
    expect(loadState().completed[0].actual_min).toBe(7);
  });

  it('没有开始时间 → 回退预估工时', () => {
    seed();
    runCommand(createDoneCommand(), ['T2', '--force']);
    expect(loadState().completed[0].actual_min).toBe(45);
  });

  it('开始时间非法 → 回退预估工时,不崩溃', () => {
    seed('not-a-timestamp');
    const r = runCommand(createDoneCommand(), ['T1', '--force']);
    expect(r.exitCode).toBeUndefined();
    expect(loadState().completed[0].actual_min).toBe(10);
  });
});
