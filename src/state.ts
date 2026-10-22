import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  POOL_FILE,
  WORKFLOW_FILE,
  STATE_FILE,
  LOG_FILE,
  CHECKPOINT_FILE,
  CHECKPOINT_BACKUP,
  ensureBaseDir,
  getBaseDir,
} from './paths.js';
import { fmtDateTime, isoNow, rotateFileIfLarge } from './util.js';
import { t } from './i18n.js';
import { assertTaskId } from './task-id.js';

export interface Review {
  verify_run_id?: string;
  result: string;
  level: string;
  note: string;
  at: string;
}

export interface VerifyPassed {
  run_id?: string;
  at: string;
  commands: string[];
  head?: string;
  dirty_diff_hash?: string;
}

export interface VerificationRun {
  id: string;
  status: 'running' | 'passed' | 'failed';
  at: string;
  commands: string[];
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
  verify_passed?: VerifyPassed;
  verification_run?: VerificationRun;
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

/** Workflow tasks are declarative; status/dependencies default during compilation. */
export interface WorkflowStage {
  id: string;
  name?: string;
  agent: string;
  depends_on?: string[];
  gate_commands?: string[];
  tasks: (Omit<Task, 'status' | 'depends_on'> & Partial<Pick<Task, 'status' | 'depends_on'>>)[];
}

export interface Workflow {
  name: string;
  description?: string;
  schedule?: Pool['schedule'];
  checkpoint?: Pool['checkpoint'];
  stages: WorkflowStage[];
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

/** store 级锁的基名:与单文件写锁(${file}.lock)分开,避免自锁。 */
const STORE_LOCK_BASE = (): string => path.join(getBaseDir(), '.store');

/**
 * 在跨进程锁内执行"读-改-写"事务。
 * 回调返回 false 表示放弃本次写入(例如目标任务已不存在)。
 * 锁预算内拿不到锁时仍然执行(宁可继续也不让 CLI 死锁),但会告警。
 */
export function withStoreLock<T>(fn: () => T): T {
  ensureBaseDir();
  let locked = false;
  try {
    locked = acquireLockWithRetry(STORE_LOCK_BASE());
  } catch {
    locked = false;
  }
  if (!locked) {
    console.error(
      `[nightowl] warn: store lock busy within ${lockTiming.budgetMs}ms; ` +
        'writing without cross-process serialization',
    );
  }
  try {
    return fn();
  } finally {
    if (locked) releaseLock(STORE_LOCK_BASE());
  }
}

/**
 * 事务化修改任务池:锁内重新读取最新文件,再应用变更。
 * 这是修"长任务用陈旧快照整文件回写、覆盖并发修改"的关键:
 * verify 跑测试期间别人改了 review/status,这里不会把它们抹掉。
 */
export function updatePool(mutate: (pool: Pool) => boolean | void): boolean {
  return withStoreLock(() => {
    const pool = loadPool();
    if (!pool) return false;
    if (mutate(pool) === false) return false;
    atomicWrite(POOL_FILE(), yaml.dump(pool, { noRefs: true }));
    return true;
  });
}

/** 事务化修改运行状态;语义同 updatePool。 */
export function updateState(mutate: (state: AppState) => boolean | void): boolean {
  return withStoreLock(() => {
    const state = loadState();
    if (mutate(state) === false) return false;
    atomicWrite(STATE_FILE(), yaml.dump(state, { noRefs: true }));
    return true;
  });
}

export function loadPool(): Pool | null {
  const f = POOL_FILE();
  if (!fs.existsSync(f)) return null;
  const data = yaml.load(fs.readFileSync(f, 'utf8')) as Pool | null;
  return data ?? null;
}

export function loadWorkflow(): Workflow | null {
  const f = WORKFLOW_FILE();
  if (!fs.existsSync(f)) return null;
  const data: unknown = yaml.load(fs.readFileSync(f, 'utf8'));
  if (data === null || data === undefined) return null;
  // Validate the expanded graph too: persisted workflows must always be compilable.
  assertWorkflow(data);
  workflowToPool(data);
  return data;
}

export function saveWorkflow(workflow: Workflow): void {
  workflowToPool(workflow);
  atomicWrite(WORKFLOW_FILE(), yaml.dump(workflow, { noRefs: true }));
}

function workflowFieldError(field: string, expected: string): never {
  throw new Error(t('workflow.invalidField', { field, expected: t(`workflow.expected.${expected}`) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) workflowFieldError(field, 'string');
}

function assertStrings(value: unknown, field: string): void {
  if (!Array.isArray(value)) workflowFieldError(field, 'strings');
  for (const [i, item] of value.entries()) assertString(item, `${field}[${i}]`);
}

/** YAML is untrusted input; check its shape before compiling or writing either file. */
function assertWorkflow(value: unknown): asserts value is Workflow {
  if (!isRecord(value)) workflowFieldError('workflow', 'object');
  assertString(value.name, 'name');
  if (value.description !== undefined) assertString(value.description, 'description');
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    workflowFieldError('stages', 'nonEmptyArray');
  }
  for (const [i, stage] of value.stages.entries()) {
    const field = `stages[${i}]`;
    if (!isRecord(stage)) workflowFieldError(field, 'object');
    assertString(stage.id, `${field}.id`);
    assertTaskId(stage.id);
    assertString(stage.agent, `${field}.agent`);
    if (stage.name !== undefined) assertString(stage.name, `${field}.name`);
    if (stage.depends_on !== undefined) assertStrings(stage.depends_on, `${field}.depends_on`);
    if (stage.gate_commands !== undefined) assertStrings(stage.gate_commands, `${field}.gate_commands`);
    if (!Array.isArray(stage.tasks) || stage.tasks.length === 0) {
      workflowFieldError(`${field}.tasks`, 'nonEmptyArray');
    }
    for (const [j, task] of stage.tasks.entries()) {
      const taskField = `${field}.tasks[${j}]`;
      if (!isRecord(task)) workflowFieldError(taskField, 'object');
      assertString(task.id, `${taskField}.id`);
      assertTaskId(task.id);
      assertString(task.title, `${taskField}.title`);
      if (typeof task.priority !== 'string' || !['P0', 'P1', 'P2'].includes(task.priority)) {
        workflowFieldError(`${taskField}.priority`, 'priority');
      }
      if (typeof task.est_min !== 'number' || !Number.isFinite(task.est_min) || task.est_min < 0) {
        workflowFieldError(`${taskField}.est_min`, 'nonNegativeNumber');
      }
      for (const key of ['depends_on', 'verify']) {
        if (task[key] !== undefined) assertStrings(task[key], `${taskField}.${key}`);
      }
      for (const key of ['status', 'assignee', 'description', 'acceptance', 'prd_path']) {
        if (task[key] !== undefined) assertString(task[key], `${taskField}.${key}`);
      }
    }
  }
  if (value.schedule !== undefined) {
    if (!isRecord(value.schedule)) workflowFieldError('schedule', 'object');
    if (!Number.isInteger(value.schedule.retry_budget) || Number(value.schedule.retry_budget) < 0) {
      workflowFieldError('schedule.retry_budget', 'nonNegativeInteger');
    }
  }
  if (value.checkpoint !== undefined) {
    if (!isRecord(value.checkpoint)) workflowFieldError('checkpoint', 'object');
    if (typeof value.checkpoint.enabled !== 'boolean') workflowFieldError('checkpoint.enabled', 'boolean');
    if (!Number.isInteger(value.checkpoint.write_every) || Number(value.checkpoint.write_every) < 1) {
      workflowFieldError('checkpoint.write_every', 'positiveInteger');
    }
  }
}

/** Kahn's algorithm avoids recursion limits on large workflow/task graphs. */
function assertWorkflowAcyclic(graph: Map<string, string[]>, kind: 'Stage' | 'Task'): void {
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready: string[] = [];
  for (const [id, deps] of graph) {
    remaining.set(id, deps.length);
    if (deps.length === 0) ready.push(id);
    for (const dep of deps) {
      const next = dependents.get(dep) ?? [];
      next.push(id);
      dependents.set(dep, next);
    }
  }
  for (let i = 0; i < ready.length; i++) {
    for (const id of dependents.get(ready[i]) ?? []) {
      const count = (remaining.get(id) ?? 0) - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  if (ready.length !== graph.size) {
    const ids = [...remaining].filter(([, count]) => count > 0).map(([id]) => id).join(', ');
    throw new Error(t(`workflow.cycle${kind}`, { ids }));
  }
}

/** Pure adapter: execution continues to use the existing Pool scheduler and state. */
export function workflowToPool(
  workflow: Workflow,
  defaults?: Pick<Pool, 'schedule' | 'checkpoint'> | null,
): Pool {
  assertWorkflow(workflow);
  const stages = new Map<string, WorkflowStage>();
  const taskIds = new Set<string>();
  for (const stage of workflow.stages) {
    if (stages.has(stage.id)) throw new Error(t('workflow.duplicateStage', { id: stage.id }));
    stages.set(stage.id, stage);
    for (const task of stage.tasks) {
      if (taskIds.has(task.id)) throw new Error(t('workflow.duplicateTask', { id: task.id }));
      taskIds.add(task.id);
    }
  }

  const stageGraph = new Map<string, string[]>();
  for (const stage of workflow.stages) {
    const deps = [...new Set(stage.depends_on ?? [])];
    for (const dep of deps) {
      if (!stages.has(dep)) throw new Error(t('workflow.unknownStage', { id: stage.id, dep }));
    }
    stageGraph.set(stage.id, deps);
  }
  assertWorkflowAcyclic(stageGraph, 'Stage');

  const pool: Task[] = [];
  for (const stage of workflow.stages) {
    const inherited = (stageGraph.get(stage.id) ?? []).flatMap(
      (id) => stages.get(id)?.tasks.map((task) => task.id) ?? [],
    );
    for (const task of stage.tasks) {
      const deps = [...new Set([...(task.depends_on ?? []), ...inherited])];
      for (const dep of deps) {
        if (!taskIds.has(dep)) throw new Error(t('workflow.unknownTask', { id: task.id, dep }));
      }
      const verify = [...new Set([...(task.verify ?? []), ...(stage.gate_commands ?? [])])];
      // Copy nested metadata too, so callers cannot mutate the workflow through its pool.
      const compiled: Task = {
        ...structuredClone(task),
        status: task.status ?? 'pending',
        depends_on: deps,
        assignee: stage.agent,
      };
      if (verify.length || task.verify !== undefined || stage.gate_commands !== undefined) compiled.verify = verify;
      pool.push(compiled);
    }
  }
  assertWorkflowAcyclic(new Map(pool.map((task) => [task.id, task.depends_on])), 'Task');
  return {
    schedule: { ...(workflow.schedule ?? defaults?.schedule ?? { retry_budget: 2 }) },
    checkpoint: { ...(workflow.checkpoint ?? defaults?.checkpoint ?? { enabled: true, write_every: 1 }) },
    pool,
  };
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

/** nightowl.log 单文件上限:超过则轮转为 .1(只保留一份),防无人值守长跑无限膨胀。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logMaxBytes = LOG_MAX_BYTES;

/** 仅供单测调整日志轮转阈值;传 null 恢复默认。 */
export function setLogMaxBytesForTest(n: number | null): void {
  logMaxBytes = n ?? LOG_MAX_BYTES;
}

export function log(msg: string): void {
  ensureBaseDir();
  rotateFileIfLarge(LOG_FILE(), logMaxBytes);
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
