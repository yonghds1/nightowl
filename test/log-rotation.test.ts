import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir, LOG_FILE } from '../src/paths.js';
import { log, setLogMaxBytesForTest } from '../src/state.js';
import { minutesBetween, parseLocalIso, isoOf } from '../src/util.js';
import { captureConsole } from './helpers.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-log-'));
  setBaseDir(path.join(root, '.nightowl'));
  captureConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogMaxBytesForTest(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nightowl.log 轮转', () => {
  it('超过阈值后改名 .1,当前文件重新开始,不无限膨胀', () => {
    setLogMaxBytesForTest(200);
    for (let i = 0; i < 6; i++) log(`line-${i} ${'x'.repeat(60)}`);

    const current = LOG_FILE();
    const backup = `${current}.1`;
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(backup)).toBe(true);

    // 最新一行一定还在当前文件;旧内容进了 .1
    expect(fs.readFileSync(current, 'utf8')).toContain('line-5');
    expect(fs.readFileSync(backup, 'utf8')).toContain('line-0');
    expect(fs.statSync(current).size).toBeLessThanOrEqual(200 + 80);
  });

  it('未超阈值不轮转', () => {
    setLogMaxBytesForTest(1024 * 1024);
    log('only line');
    expect(fs.existsSync(`${LOG_FILE()}.1`)).toBe(false);
  });
});

describe('实际用时计算', () => {
  it('分钟数向上取整且最少 1 分钟', () => {
    const now = new Date(2026, 9, 22, 12, 0, 0);
    expect(minutesBetween(isoOf(new Date(2026, 9, 22, 11, 30, 0)), now)).toBe(30);
    expect(minutesBetween(isoOf(new Date(2026, 9, 22, 11, 59, 30)), now)).toBe(1);
    expect(minutesBetween(isoOf(new Date(2026, 9, 22, 12, 0, 10)), now)).toBeNull(); // 未来时间
    expect(minutesBetween('bad-value', now)).toBeNull();
  });

  it('非法日期不自动进位(02-30 视为非法)', () => {
    expect(parseLocalIso('2026-02-30T10:00:00.000')).toBeNull();
    expect(parseLocalIso('2026-10-22T10:00:00.000')).not.toBeNull();
  });
});
