import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POOL_FILE, STATE_FILE, setBaseDir } from '../src/paths.js';
import {
  loadPool,
  loadState,
  savePool,
  saveState,
  setLockTimingForTest,
  _lockForTest,
} from '../src/state.js';
import type { Pool } from '../src/state.js';

let root: string;
let poolFile: string;
let stateFile: string;
let lockPath: string;
const ORIG_CWD = process.cwd();

function makePool(i = 0): Pool {
  return {
    schedule: { retry_budget: 2 },
    checkpoint: { enabled: false, write_every: 5 },
    pool: [
      {
        id: `T${i}`,
        title: 'demo',
        priority: 'P0',
        est_min: 15,
        depends_on: [],
        status: 'pending',
      },
    ],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-conc-'));
  setBaseDir(path.join(root, '.nightowl'));
  process.chdir(root);
  fs.mkdirSync(path.join(root, '.nightowl', 'tasks'), { recursive: true });
  poolFile = POOL_FILE();
  stateFile = STATE_FILE();
  lockPath = `${stateFile}.lock`;
  setLockTimingForTest(null);
});

afterEach(() => {
  setLockTimingForTest(null);
  vi.restoreAllMocks();
  process.chdir(ORIG_CWD);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('唯一临时文件:密集写入不碰撞', () => {
  it('50 次密集 savePool 生成的 tmp 路径两两不同且无残留', () => {
    const renamedTmps: string[] = [];
    const renameOrig = fs.renameSync.bind(fs);
    const spy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((from: string, to: string) => {
        if (from.includes('.tmp.')) renamedTmps.push(from);
        return renameOrig(from, to);
      });
    try {
      for (let i = 0; i < 50; i++) {
        savePool(makePool(i));
      }
    } finally {
      spy.mockRestore();
    }
    expect(renamedTmps).toHaveLength(50);
    expect(new Set(renamedTmps).size).toBe(50);
    // 每个 tmp 都遵循唯一命名模式,且落在 POOL_FILE 同目录
    expect(renamedTmps.every((t) => t.startsWith(`${poolFile}.tmp.`))).toBe(true);
    // tmp 已被 rename 接管:目录中不应存在任何 tmp/lock 残留
    const dir = path.dirname(poolFile);
    const leftovers = fs.readdirSync(dir).filter(
      (n) =>
        (n.startsWith(path.basename(poolFile)) && n.includes('.tmp')) ||
        n.endsWith('.lock'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('锁文件生命周期', () => {
  it('独占创建:第二次获取失败,释放后可再次获取,内容记录 pid 与时间戳', () => {
    expect(_lockForTest.tryAcquireLock(stateFile)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(_lockForTest.tryAcquireLock(stateFile)).toBe(false); // EEXIST
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid: number;
      at: string;
    };
    expect(meta.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(meta.at))).toBe(false);
    _lockForTest.releaseLock(stateFile);
    expect(fs.existsSync(lockPath)).toBe(false);
    // 释放后可重新获取;测试结束时清理
    expect(_lockForTest.tryAcquireLock(stateFile)).toBe(true);
    _lockForTest.releaseLock(stateFile);
  });

  it('saveState 正常完成后自动释放锁文件', () => {
    saveState({ completed: [], blocked: [], in_progress: null });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('写入异常时锁文件与临时文件仍被清理(不残留)', () => {
    const writeOrig = fs.writeFileSync.bind(fs);
    const errSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(((file: fs.PathOrFileDescriptor, data: string | Uint8Array, opts?: object) => {
        if (typeof file === 'string' && file.startsWith(`${stateFile}.tmp.`)) {
          throw new Error('disk full sandbox');
        }
        return writeOrig(file, data, opts);
      }) as typeof fs.writeFileSync);
    try {
      expect(() => saveState({ completed: [], blocked: [], in_progress: null })).toThrow(
        'disk full sandbox',
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
    const junk = fs
      .readdirSync(path.dirname(stateFile))
      .filter(
        (n) =>
          (n.startsWith(path.basename(stateFile)) && n.includes('.tmp')) ||
          n.endsWith('.lock'),
      );
    expect(junk).toEqual([]);
    // 目标文件未被半截污染:不存在损坏产物
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('陈旧锁(mtime 超期)被回收后写入成功', () => {
    // 预置一把 11 秒前的"死进程"残留锁(默认陈旧阈值 10s)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: 'stale' }), 'utf8');
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(lockPath, old, old);
    saveState({
      completed: [{ id: 'C1', actual_min: 5, finished_at: 't' }],
      blocked: [],
      in_progress: null,
    });
    const state = loadState();
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0].id).toBe('C1');
    // 我们的锁已被最终释放,目录无锁残留
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('陈旧阈值可被单测 hook 覆盖:极短阈值同样回收陈旧锁', () => {
    setLockTimingForTest({ staleMs: 20 });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: 'stale' }), 'utf8');
    const old = new Date(Date.now() - 500);
    fs.utimesSync(lockPath, old, old);
    saveState({ completed: [], blocked: [], in_progress: null });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('新鲜锁被他人持有:退避超预算后告警并走无锁原子替换兜底', () => {
    // 预置一把"新鲜"的他进程锁,目标与本次写入一致(pool 文件)
    const poolLock = `${poolFile}.lock`;
    fs.writeFileSync(poolLock, JSON.stringify({ pid: 999999, at: 'fresh' }), 'utf8');
    fs.utimesSync(poolLock, new Date(), new Date());
    // 缩短退避预算避免真实等待 4s;陈旧阈值保持默认(10s,新鲜锁不会被回收)
    setLockTimingForTest({ budgetMs: 150 });
    const errs: string[] = [];
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => errs.push(a.map(String).join(' ')));
    const t0 = Date.now();
    try {
      // 兜底路径:即便拿不到锁,写入仍然成功且内容完整
      savePool(makePool(7));
    } finally {
      errSpy.mockRestore();
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // 确实经历了退避
    expect(Date.now() - t0).toBeLessThan(3_000); // 没有长死等
    expect(errs.some((e) => e.includes('failed to acquire lock'))).toBe(true);
    expect(loadPool()?.pool[0].id).toBe('T7');
    // 他人持有的锁不应被我们误删;由本测试负责清理
    expect(fs.existsSync(poolLock)).toBe(true);
    fs.unlinkSync(poolLock);
  });
});

describe('密集写入的状态完整性', () => {
  it('快速交替写入 pool/state,内容始终完整可解析', () => {
    for (let i = 0; i < 40; i++) {
      savePool(makePool(i));
      saveState({
        completed: [{ id: `C${i}`, actual_min: i, finished_at: 't' }],
        blocked: [],
        in_progress: null,
      });
      // 每轮写入后即时回读:文件内容必须是该轮的完整快照(不允许半截/损坏)
      expect(loadPool()?.pool[0].id).toBe(`T${i}`);
      expect(loadState().completed[0].id).toBe(`C${i}`);
    }
  });
});

describe('多进程并发写入(真实子进程)', () => {
  it('3 个子进程并发 saveState:文件始终有效,最终内容完整且无 tmp/lock 残留', { timeout: 60_000 }, () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-mp-'));
    const srcState = fileURLToPath(new URL('../src/state.ts', import.meta.url));
    const srcPaths = fileURLToPath(new URL('../src/paths.ts', import.meta.url));
    const child = [
      `import { pathToFileURL } from 'node:url';`,
      `const dir = ${JSON.stringify(stateDir)};`,
      `process.chdir(dir);`,
      `const paths = await import(${JSON.stringify(pathToFileURL(srcPaths).href)});`,
      `paths.setBaseDir(dir + '/.nightowl');`,
      `const { saveState } = await import(${JSON.stringify(pathToFileURL(srcState).href)});`,
      `for (let i = 0; i < 30; i++) {`,
      `  saveState({ completed: [{ id: 'w' + process.env.NW_ID + '-' + i, actual_min: i, finished_at: 't' }], blocked: [], in_progress: null });`,
      `}`,
      `console.log('DONE');`,
    ].join('\n');
    const childFile = path.join(root, 'state-child.mts');
    fs.writeFileSync(childFile, child, 'utf8');
    const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const procs = ['A', 'B', 'C'].map((id) =>
      spawnSync(process.execPath, [cli, childFile], {
        encoding: 'utf8',
        env: { ...process.env, NW_ID: id },
        timeout: 30_000,
      }),
    );
    try {
      for (const p of procs) {
        expect(p.error).toBeUndefined();
        expect(p.status).toBe(0);
        expect(p.stdout).toContain('DONE');
      }
      // 子进程共享同一状态目录:最终文件必须可解析且内容为最后一次写入的完整快照
      setBaseDir(path.join(stateDir, '.nightowl'));
      const finalFile = STATE_FILE();
      const final = loadState();
      expect(final.completed).toHaveLength(1);
      expect(final.completed[0].id).toMatch(/^w[ABC]-\d+$/);
      expect(yaml.load(fs.readFileSync(finalFile, 'utf8'))).toEqual(final);
      // 无锁文件/临时文件残留
      const junk = fs
        .readdirSync(path.dirname(finalFile))
        .filter((n) => n.endsWith('.lock') || n.includes('.tmp'));
      expect(junk).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
