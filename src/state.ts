import fs from 'node:fs';
import yaml from 'js-yaml';
import {
  POOL_FILE,
  STATE_FILE,
  LOG_FILE,
  CHECKPOINT_FILE,
  CHECKPOINT_BACKUP,
  ensureBaseDir,
} from './paths.js';
import { fmtDateTime, isoNow } from './util.js';

export interface Review {
  result: string;
  level: string;
  note: string;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  priority: string;
  est_min: number;
  depends_on: string[];
  status: string;
  assignee?: string;
  description?: string;
  acceptance?: string;
  verify?: string[];
  prd_path?: string;
  actual_min?: number;
  verify_passed?: { at: string; commands: string[] };
  review?: Review;
  review_history?: Review[];
}

export interface Pool {
  schedule: {
    retry_budget: number;
  };
  checkpoint: { enabled: boolean; write_every: number };
  pool: Task[];
}

export interface CompletedEntry {
  id: string;
  actual_min: number;
  finished_at: string;
}

export interface BlockedEntry {
  id: string;
  reason: string;
  blocked_at: string;
}

export interface AppState {
  completed: CompletedEntry[];
  blocked: BlockedEntry[];
  in_progress: { id: string; started_at: string } | null;
  last_run?: string | null;
  report?: string | null;
}

export interface Checkpoint {
  version: number;
  updated_at: string;
  pool: Pool;
  state: AppState;
  stats?: { total: number; completed: number };
}

/** 锁过期阈值:锁文件 mtime 超过该时长视为陈旧锁,可安全回收(进程崩溃残留)。 */
const LOCK_STALE_MS = 10_000;
/** 总重试退避时长上限(ms):超过则放弃加锁,直接走唯一临时文件的原子替换兜底。 */
const LOCK_RETRY_BUDGET_MS = 4_000;
/** 每次退避的基准睡眠时长(ms),叠加抖动避免多进程同步踩踏。 */
const LOCK_RETRY_BACKOFF_MS = 25;
/** 最大退避睡眠时长(ms)。 */
const LOCK_RETRY_MAX_BACKOFF_MS = 200;

// 仅供单测调整的锁超时参数(运行期默认用上面的常量)
const DEFAULT_LOCK_TIMING = {
  staleMs: LOCK_STALE_MS,
  budgetMs: LOCK_RETRY_BUDGET_MS,
} as const;
let lockTiming: { staleMs: number; budgetMs: number } = { ...DEFAULT_LOCK_TIMING };

export function setLockTimingForTest(
  t: { staleMs?: number; budgetMs?: number } | null,
): void {
  lockTiming = t ? { ...lockTiming, ...t } : { ...DEFAULT_LOCK_TIMING };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 唯一临时文件名:pid + 时间戳 + 随机段,多进程/多 Agent 并发写同名目标文件不再踩踏。
 */
function uniqueTmpPath(f: string): string {
  return `${f}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 独占创建锁文件(owner 仅作观测用途,加锁安全仍依赖 openSync 'wx' 的原子性)。
 * 返回 true 表示抢锁成功;EEXIST 表示已被他人持有。
 */
function tryAcquireLock(f: string): boolean {
  try {
    const fd = fs.openSync(`${f}.lock`, 'wx');
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'utf8',
      );
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** 删除锁文件(尽力而为:他人已抢先删除或换新锁时不报错)。 */
function releaseLock(f: string): void {
  try {
    fs.unlinkSync(`${f}.lock`);
  } catch {
    /* ENOENT 或他人重试已回收,忽略 */
  }
}

/**
 * 尝试获取锁:先独占创建;遇 EEXIST 时——
 *  - mtime 超过 LOCK_STALE_MS 视为陈旧锁,删除后重试抢锁;
 *  - 否则同步退避等待,总耗时不超过 LOCK_RETRY_BUDGET_MS。
 * 返回 true 拿到锁;false 表示预算内未拿到(调用方走无锁兜底)。
 */
function acquireLockWithRetry(f: string): boolean {
  const deadline = Date.now() + lockTiming.budgetMs;
  let backoff = LOCK_RETRY_BACKOFF_MS;
  for (;;) {
    if (tryAcquireLock(f)) return true;
    // 锁被持有:检查是否陈旧(mtime 距今超过阈值即可安全回收)
    try {
      const mtime = fs.statSync(`${f}.lock`).mtimeMs;
      if (Date.now() - mtime > lockTiming.staleMs) {
        try {
          fs.unlinkSync(`${f}.lock`);
        } catch {
          /* 已被他人回收/换锁,忽略 */
        }
        continue; // 立即重试抢锁
      }
    } catch {
      // stat 失败(多半是 ENOENT):锁刚被释放,立即重试
      continue;
    }
    if (Date.now() >= deadline) return false;
    // 指数退避 + 抖动,打散多进程重试节奏
    const jitter = Math.floor(Math.random() * LOCK_RETRY_BACKOFF_MS);
    sleepSync(Math.min(backoff + jitter, LOCK_RETRY_MAX_BACKOFF_MS));
    backoff = Math.min(backoff * 2, LOCK_RETRY_MAX_BACKOFF_MS);
  }
}

/**
 * 原子写入:写唯一临时文件后 renameSync 替换(rename 单系统内原子)。
 * 异常残留临时文件在 finally 中确保清理。
 */
function writeViaTmp(f: string, content: string): void {
  const tmp = uniqueTmpPath(f);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, f);
  } finally {
    try {
      fs.unlinkSync(tmp);
      // 已成功 rename 时 unlink ENOENT 属预期,忽略
    } catch {
      /* rename 已接管或异常残留清理,忽略 */
    }
  }
}

/**
 * 跨进程安全的原子写入:
 *  1. 锁文件(${f}.lock)排他保护,降低并发读-改-写丢失更新的概率;
 *  2. 每次写唯一临时文件,彻底消除并发临时文件碰撞;
 *  3. 锁超时未拿到时告警并走无锁原子替换兜底(rename 自身原子),避免长任务死锁。
 */
export function atomicWrite(f: string, content: string): void {
  ensureBaseDir();
  let locked = false;
  try {
    try {
      locked = acquireLockWithRetry(f);
    } catch {
      // 锁机制本身异常(如权限)不阻塞业务写入,回退无锁原子替换
      locked = false;
    }
    if (!locked) {
      console.error(
        `[nightowl] warn: failed to acquire lock ${f}.lock within ${lockTiming.budgetMs}ms; ` +
          'falling back to lock-free atomic rename',
      );
    }
    writeViaTmp(f, content);
  } finally {
    if (locked) releaseLock(f);
  }
}

export const _lockForTest = {
  tryAcquireLock,
  releaseLock,
  acquireLockWithRetry,
  LOCK_STALE_MS,
  LOCK_RETRY_BUDGET_MS,
};

export function loadPool(): Pool | null {
  const f = POOL_FILE();
  if (!fs.existsSync(f)) return null;
  const data = yaml.load(fs.readFileSync(f, 'utf8')) as Pool | null;
  return data ?? null;
}

export function loadState(): AppState {
  const f = STATE_FILE();
  if (!fs.existsSync(f)) return { completed: [], blocked: [], in_progress: null };
  const data = yaml.load(fs.readFileSync(f, 'utf8')) as AppState | null;
  return data ?? { completed: [], blocked: [], in_progress: null };
}

export function savePool(pool: Pool): void {
  atomicWrite(POOL_FILE(), yaml.dump(pool, { noRefs: true }));
}

export function saveState(state: AppState): void {
  atomicWrite(STATE_FILE(), yaml.dump(state, { noRefs: true }));
}

export function log(msg: string): void {
  ensureBaseDir();
  const line = `[${fmtDateTime()}] ${msg}`;
  fs.appendFileSync(LOG_FILE(), `${line}\n`, 'utf8');
  console.log(line);
}

export function saveCheckpoint(
  pool: Pool,
  state: AppState,
  stats?: { total: number; completed: number },
): void {
  ensureBaseDir();
  // 双轮切换:当前文件 → backup,始终留一份完整数据
  if (fs.existsSync(CHECKPOINT_FILE())) {
    fs.renameSync(CHECKPOINT_FILE(), CHECKPOINT_BACKUP());
  }
  const cp: Checkpoint = {
    version: 1,
    updated_at: isoNow(),
    pool,
    state,
    ...(stats ? { stats } : {}),
  };
  atomicWrite(CHECKPOINT_FILE(), yaml.dump(cp, { noRefs: true }));
}

export function loadCheckpoint(): Checkpoint | null {
  for (const f of [CHECKPOINT_FILE(), CHECKPOINT_BACKUP()]) {
    if (fs.existsSync(f)) {
      try {
        const data = yaml.load(fs.readFileSync(f, 'utf8')) as Checkpoint | null;
        if (data) return data;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function clearCheckpoint(): void {
  for (const f of [CHECKPOINT_FILE(), CHECKPOINT_BACKUP()]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

export function shouldCheckpoint(state: AppState, interval = 1): boolean {
  const doneCount = state.completed.length;
  return doneCount > 0 && doneCount % interval === 0;
}
