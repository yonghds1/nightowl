import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { loadPool } from '../src/state.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createDoneCommand } from '../src/commands/done.js';
import { createReviewCommand } from '../src/commands/review.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createReportCommand } from '../src/commands/report.js';
import { runCommand } from './helpers.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-sched-'));
  setBaseDir(path.join(root, '.nightowl'));
  runCommand(createInitCommand(), ['--skip-permissions']);
  runCommand(createAddCommand(), [
    '--id', 'T1', '--title', 'Demo task', '--priority', 'P0', '--est-min', '15',
  ]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function task(tid = 'T1') {
  return loadPool()!.pool.find((t) => t.id === tid)!;
}

describe('done 审查关口', () => {
  it('无审查记录拒绝 done', () => {
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('尚未代码审查');
    expect(task().status).toBe('pending');
  });

  it('审查 PASS 后 done 通过', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).toBeUndefined();
    expect(task().status).toBe('done');
  });

  it('审查 FAIL 拒绝 done', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'FAIL', '--note', '有 P1']);
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('审查未通过');
    expect(task().status).toBe('pending');
  });

  it('审查 PASS_WITH_NITS 通过', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS_WITH_NITS']);
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).toBeUndefined();
    expect(task().status).toBe('done');
  });

  it('审查非法值(非 PASS/PASS_WITH_NITS)拒绝 done', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'CHANGES_REQUESTED']);
    const r = runCommand(createDoneCommand(), ['T1', '5']);
    expect(r.exitCode).not.toBe(0);
    expect(task().status).toBe('pending');
  });

  it('--force 跳过审查关口', () => {
    const r = runCommand(createDoneCommand(), ['T1', '5', '--force']);
    expect(r.exitCode).toBeUndefined();
    expect(task().status).toBe('done');
  });
});

describe('done verify 关口', () => {
  function addVerified(): void {
    runCommand(createAddCommand(), [
      '--id', 'T2', '--title', 'Verified', '--priority', 'P1', '--est-min', '15',
      '--verify', 'true',
    ]);
  }

  it('有 verify 命令但未跑,拒绝 done', () => {
    addVerified();
    runCommand(createReviewCommand(), ['T2', '--result', 'PASS']);
    const r = runCommand(createDoneCommand(), ['T2', '5']);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('尚未通过验收测试');
    expect(task('T2').status).toBe('pending');
  });

  it('verify 通过后 done 放行', () => {
    addVerified();
    runCommand(createReviewCommand(), ['T2', '--result', 'PASS']);
    runCommand(createVerifyCommand(), ['T2']);
    const r = runCommand(createDoneCommand(), ['T2', '5']);
    expect(r.exitCode).toBeUndefined();
    expect(task('T2').status).toBe('done');
  });

  it('--force 跳过 verify 关口', () => {
    addVerified();
    const r = runCommand(createDoneCommand(), ['T2', '5', '--force']);
    expect(r.exitCode).toBeUndefined();
    expect(task('T2').status).toBe('done');
  });

  it('verify 记录 verify_passed', () => {
    addVerified();
    runCommand(createVerifyCommand(), ['T2']);
    const t = task('T2');
    expect(t.verify_passed).toBeTruthy();
    expect(t.verify_passed!.commands).toEqual(['true']);
  });
});

describe('review 历史', () => {
  it('多轮审查累积 review_history', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'FAIL', '--note', '首轮有 P1']);
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS', '--note', '修复后通过']);
    const t = task();
    expect(t.review!.result).toBe('PASS');
    expect(t.review_history).toHaveLength(1);
    expect(t.review_history![0].result).toBe('FAIL');
    expect(t.review_history![0].note).toBe('首轮有 P1');
  });

  it('首次审查不产生 history', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    expect(task().review_history).toBeUndefined();
  });

  it('记录审查级别 light', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS', '--level', 'light']);
    expect(task().review!.level).toBe('light');
  });

  it('默认级别 full', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
    expect(task().review!.level).toBe('full');
  });
});

describe('report 审查过程段', () => {
  it('报告包含审查历史', () => {
    runCommand(createReviewCommand(), ['T1', '--result', 'FAIL', '--note', '首轮有 P1']);
    runCommand(createReviewCommand(), ['T1', '--result', 'PASS', '--note', '修复后通过']);
    const r = runCommand(createReportCommand(), []);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('## 审查过程');
    expect(r.stdout).toContain('✅ PASS — 修复后通过');
    expect(r.stdout).toContain('第 1 轮: ❌ FAIL — 首轮有 P1');
  });
});
