import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir, POOL_FILE } from '../src/paths.js';
import {
  loadPool,
  savePool,
  updatePool,
  loadState,
  saveState,
  updateState,
  type Pool,
} from '../src/state.js';
import { createReviewCommand } from '../src/commands/review.js';
import { recordVerifyPassed } from '../src/commands/verify.js';
import { isoNow } from '../src/util.js';
import { runCommand } from './helpers.js';

let root: string;

function poolFixture(): Pool {
  return {
    schedule: { retry_budget: 1 },
    checkpoint: { enabled: false, write_every: 1 },
    pool: [
      { id: 'T1', title: 'Task 1', priority: 'P1', est_min: 10, depends_on: [], status: 'pending' },
      { id: 'T2', title: 'Task 2', priority: 'P2', est_min: 20, depends_on: [], status: 'pending' },
    ],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-tx-'));
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pool/state 的事务化写入', () => {
  it('updatePool 在锁内重新读取,陈旧快照不会覆盖并发修改', () => {
    savePool(poolFixture());
    // 模拟"任务开跑前读到、跑到一半已经过期"的快照
    const stale = loadPool()!;
    stale.pool[0].title = 'stale title';

    // 另一个写者先改了 T2
    updatePool((fresh) => {
      fresh.pool[1].title = 'concurrent';
      return true;
    });
    // 后续写者只改 T1 的优先级
    updatePool((fresh) => {
      fresh.pool[0].priority = 'P0';
      return true;
    });

    const fresh = loadPool()!;
    expect(fresh.pool[0].title).toBe('Task 1'); // 陈旧快照没被写回
    expect(fresh.pool[0].priority).toBe('P0');
    expect(fresh.pool[1].title).toBe('concurrent');
  });

  it('回调返回 false 时不落盘', () => {
    savePool(poolFixture());
    const before = fs.readFileSync(POOL_FILE(), 'utf8');
    expect(updatePool(() => false)).toBe(false);
    expect(fs.readFileSync(POOL_FILE(), 'utf8')).toBe(before);
  });

  it('verify 回执写入不覆盖并发 review(回归:长任务整文件回写)', () => {
    savePool(poolFixture());

    // 模拟 verify 开跑前读到的快照(旧实现会拿它 savePool)
    const snapshot = loadPool()!;
    expect(snapshot.pool[0].review).toBeUndefined();

    // verify 跑测试期间,review 完成
    const r = runCommand(createReviewCommand(), ['T1', '--result', 'PASS', '--note', 'lgtm']);
    expect(r.exitCode).toBeUndefined();

    // verify 结束写回执
    expect(recordVerifyPassed('T1', { at: isoNow(), commands: ['true'] })).toBe(true);

    const fresh = loadPool()!;
    expect(fresh.pool[0].review?.result).toBe('PASS');
    expect(fresh.pool[0].verify_passed?.commands).toEqual(['true']);
  });

  it('updateState 事务内重读,不同字段的并发写入都保留', () => {
    saveState({ completed: [], blocked: [], in_progress: null });
    updateState((s) => {
      s.report = 'r1';
    });
    updateState((s) => {
      s.last_run = 'r2';
    });

    const state = loadState();
    expect(state.report).toBe('r1');
    expect(state.last_run).toBe('r2');
  });
});
