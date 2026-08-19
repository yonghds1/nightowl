import { Command } from 'commander';
import { git } from '../git.js';
import { loadPool, loadState, saveState, type AppState, type Pool, type Task } from '../state.js';
import { isoNow } from '../util.js';
import { t as tr } from '../i18n.js';

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

/** 挑下一个可执行任务:跳过 done/blocked/非 pending,依赖须全完成;按优先级+估值排序。 */
export function nextTask(pool: Pool, state: AppState): Task | null {
  const doneIds = new Set(state.completed.map((c) => c.id));
  const blockedIds = new Set(state.blocked.map((b) => b.id));
  const candidates: Task[] = [];
  for (const t of pool.pool) {
    if (doneIds.has(t.id) || blockedIds.has(t.id)) continue;
    if (t.status !== undefined && t.status !== 'pending') continue;
    const deps = t.depends_on ?? [];
    if (deps.some((d) => !doneIds.has(d))) continue;
    candidates.push(t);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return (a.est_min ?? 999) - (b.est_min ?? 999);
  });
  return candidates[0];
}

/** 续跑幂等检测:该任务 id 是否有 git commit(commit message 带任务 id)。 */
export function taskCommitStatus(
  tid: string,
): { status: 'unmerged' | 'merged' | null; hash: string | null } {
  const out = git(['log', '--all', '--oneline', '--grep', tid]).stdout;
  const head = git(['rev-parse', 'HEAD']).stdout;
  if (!out || !head) return { status: null, hash: null };
  const hashes = out
    .split('\n')
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
  for (const h of hashes) {
    const r = git(['merge-base', '--is-ancestor', h, head]);
    if (r.code !== 0) return { status: 'unmerged', hash: h };
  }
  return { status: 'merged', hash: hashes[0] };
}

/** 判活:优先返回 in_progress 的未完成任务(崩溃续跑),否则 nextTask 挑下一个可执行任务。 */
export function pickNextTask(pool: Pool, state: AppState): Task | null {
  const ip = state.in_progress;
  if (ip?.id) {
    const t = pool.pool.find((x) => x.id === ip.id);
    if (t) {
      const doneIds = new Set(state.completed.map((c) => c.id));
      const blockedIds = new Set(state.blocked.map((b) => b.id));
      if (!doneIds.has(t.id) && !blockedIds.has(t.id)) return t;
    }
  }
  return nextTask(pool, state);
}

/** 打印任务块:调度循环解析的主工作区根 + 制表符字段 + PRD/DESCRIPTION/ACCEPTANCE/VERIFY。 */
export function printTask(t: Task): void {
  console.log(`WORKTREE_ROOT: ${process.cwd()}`);
  console.log(`${t.id}\t${t.title}\t${t.priority}\t${t.est_min}`);
  if (t.prd_path) console.log(`PRD_PATH: ${t.prd_path}`);
  if (t.description) console.log(`DESCRIPTION:\n${t.description}`);
  if (t.acceptance) console.log(`ACCEPTANCE:\n${t.acceptance}`);
  if (t.verify?.length) console.log(`VERIFY: ${t.verify.join(', ')}`);
}

export function createNextCommand(): Command {
  return new Command('next')
    .description(tr('next.desc'))
    .action(() => {
      const pool = loadPool();
      if (!pool) {
        console.error(tr('common.noPool'));
        process.exit(1);
      }
      const state = loadState();
      const t = pickNextTask(pool, state);
      if (!t) {
        console.log('NO_TASK');
        return;
      }
      // 崩溃续跑:选中任务仍是 in_progress → 输出 RESUME 分支标记(续跑幂等)
      if (t.id === state.in_progress?.id) {
        const cs = taskCommitStatus(t.id);
        if (cs.status === 'unmerged') console.log(`# RESUME_MERGE ${t.id} ${cs.hash}`);
        else if (cs.status === 'merged') console.log(`# RESUME_COMMITTED ${t.id} ${cs.hash}`);
        else console.log(`# RESUME in_progress ${t.id}`);
      } else {
        state.in_progress = { id: t.id, started_at: isoNow() };
        saveState(state);
      }
      printTask(t);
    });
}
