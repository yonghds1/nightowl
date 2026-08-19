import { Command } from 'commander';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPool, loadState, saveState, savePool, saveCheckpoint, type AppState } from '../state.js';
import { pickNextTask } from './next.js';
import { resolvePlatform } from '../platforms/index.js';
import type { HeadlessRun } from '../platforms/types.js';
import { REPORT_FILE, SUPERVISOR_LOG, getBaseDir } from '../paths.js';
import { fmtDateTime, isoNow } from '../util.js';
import { t } from '../i18n.js';

// 无人值守续跑指令:精简版,主会话会读 nightowl-run skill 拿完整流程。
// 每轮 spawn 都注入,让模型知道这是 supervise 拉起的续跑轮次。
export const SUPERVISOR_PROMPT = `你是 nightowl 无人值守调度会话。本会话延续上次主会话(--continue)。
按 nightowl-run 技能继续推进任务池:先 nightowl status 看进度,再进入调度循环
(sweep → next → 实现/审查子会话 → verify → 合并 → done)。
本轮尽可能推进,但当判断该停了(上下文接近上限/无待办/无法推进)就正常结束本轮。
静默契约:不向用户提问,状态落盘 .nightowl/。任务池完成则简述成果后结束。`;

// 收尾轮指令:业务任务已耗尽,只做收尾(report 是 run 最后一环,主会话提前结束本轮时由 supervise 兜底拉起)。
export const FINALIZE_PROMPT = `你是 nightowl 无人值守收尾会话。任务池业务任务已全部完成,本轮只做收尾:
按 nightowl-run 技能的"收尾推送"执行:清理残留 worktree → 推送未推送 commit(仅 bypass 下静默 push)
→ 运行 nightowl report 生成报告(.nightowl/nightowl.report.md 必须生成)。
收尾完成后正常结束本轮。推送失败不重试超 2 次,report 无论如何要生成。
静默契约:不向用户提问。`;

// --- 纯函数(可单测) ---

/** 进度指纹:completed + blocked 数量。任一变化都算本轮有进展(block 也是状态推进)。 */
export function progressSig(state: AppState): string {
  return `${state.completed.length}:${state.blocked.length}`;
}

/** 指数退避秒数,上限 60s。 */
export function backoffSec(attempt: number): number {
  return Math.min(2 ** attempt, 60);
}

/** 空转判定:连续 idleRounds 轮无进展且 >= maxIdle 时应停止。 */
export function shouldStopIdle(idleRounds: number, maxIdle: number): boolean {
  return idleRounds >= maxIdle;
}

/** 日志超阈值则改名 .1 重开(保留最近一份),防无人值守整晚膨胀。 */
export function rotateLogIfLarge(logPath: string, maxBytes: number): void {
  if (!fs.existsSync(logPath)) return;
  const st = fs.statSync(logPath);
  if (st.size > maxBytes) fs.renameSync(logPath, `${logPath}.1`);
}

// --- spawn 一轮主会话 ---

export interface HostRoundResult {
  /** 退出码:0=正常,非 0=失败。 */
  code: number;
  /** 本轮运行毫秒数(用于区分快速失败与超时)。 */
  elapsedMs: number;
}

/** spawn 宿主 headless 会话跑一轮,超时 kill。onSpawn 暴露子进程(供信号处理 kill)。 */
export function runHostRound(
  hr: HeadlessRun,
  prompt: string,
  timeoutMs: number,
  useContinue: boolean,
  logLine: (l: string) => void,
  onSpawn?: (c: ChildProcess) => void,
): Promise<HostRoundResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = hr.args(prompt, useContinue);
    const child = spawn(hr.cmd, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(child);
    child.stdout.on('data', (d: Buffer) => logLine(`[out] ${d.toString()}`));
    child.stderr.on('data', (d: Buffer) => logLine(`[err] ${d.toString()}`));
    const timer = setTimeout(() => {
      logLine(`[timeout] ${timeoutMs}ms 超时,强制结束本轮`);
      child.kill('SIGKILL');
    }, timeoutMs);
    const elapsed = (): number => Date.now() - started;
    child.on('error', (err) => {
      clearTimeout(timer);
      logLine(`[spawn-error] ${err.message}`);
      resolve({ code: 1, elapsedMs: elapsed() });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, elapsedMs: elapsed() });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 阻塞指定任务:同步 pool task.status + state.blocked + checkpoint(与 nightowl block 一致)。 */
export function blockInProgress(state: AppState, id: string, reason: string): void {
  const pool = loadPool();
  const task = pool?.pool.find((t) => t.id === id);
  if (pool && task) {
    task.status = 'blocked';
    savePool(pool);
  }
  state.blocked.push({ id, reason, blocked_at: isoNow() });
  state.in_progress = state.in_progress?.id === id ? null : state.in_progress;
  saveState(state);
  if (pool) {
    const checkpointCfg = pool.checkpoint ?? { enabled: true, write_every: 1 };
    if (checkpointCfg.enabled ?? true) {
      saveCheckpoint(pool, state, { total: pool.pool.length, completed: state.completed.length });
    }
  }
}

/** 有阻塞任务时退出码 1(无人值守驱动方凭退出码区分"全绿/需介入")。 */
function blockedExitCode(): number {
  return loadState().blocked.length > 0 ? 1 : 0;
}

export interface SuperviseOptions {
  intervalSec: number;
  timeoutMin: number;
  maxIdle: number;
  once: boolean;
}

/** 核心循环:判活 → spawn 主会话 → 判进展 → 退避/空转 → 直到任务池完成退出。
 *  hrOverride 仅供测试注入 fake host;生产不传,走 resolvePlatform().headlessRun。
 *  onSpawn 暴露当前子进程(生产 action 绑信号 kill)。 */
export async function superviseLoop(
  opts: SuperviseOptions,
  logLine: (l: string) => void,
  hrOverride?: HeadlessRun,
  onSpawn?: (c: ChildProcess) => void,
): Promise<number> {
  // 项目根从 baseDir 派生(测试 setBaseDir 时同步生效),再解析平台读 .nightowl/.platform。
  const platform = resolvePlatform(undefined, path.dirname(getBaseDir()));
  const hr = hrOverride ?? platform.headlessRun;
  if (!hr) {
    console.error(t('supervise.noHeadless', { platform: platform.name }));
    return 1;
  }
  let idleRounds = 0;
  let attempt = 0;
  let rounds = 0;
  const timeoutMs = opts.timeoutMin * 60_000;

  while (true) {
    const pool = loadPool();
    if (!pool) {
      console.error(t('common.noPool'));
      return 1;
    }
    const state = loadState();
    const task = pickNextTask(pool, state);
    if (!task) {
      // pickNextTask null 有歧义:可能是真耗尽,也可能剩余任务依赖未满足(依赖被 block 或循环依赖)。
      // 卡死 ≠ run 完成——须先区分,否则谎称"run 完成"退出 0 会漏掉永远 pending 的任务。
      const pending = pool.pool.length - state.completed.length - state.blocked.length;
      if (pending > 0) {
        console.error(t('supervise.deadlock', { n: pending, total: pool.pool.length }));
        return 1;
      }
      // 真耗尽:收尾(report)是 run 最后一环,由主会话执行。主会话可能完成最后任务后提前结束本轮
      // (上下文临界),report 未落盘 → 再拉起收尾轮兜底,然后才退出。
      // completed>0 才兜底:空池(没跑过任务)拉起收尾轮会真跑 claude 且可能 push 未推送 commit,是意外副作用。
      if (state.completed.length > 0 && !fs.existsSync(REPORT_FILE())) {
        logLine(t('supervise.finalizeRound'));
        const fr = await runHostRound(hr, FINALIZE_PROMPT, timeoutMs, true, logLine, onSpawn);
        if (fr.code !== 0) logLine(t('supervise.finalizeFail'));
      }
      const doneMsg =
        state.blocked.length > 0
          ? t('supervise.doneBlocked', {
              done: state.completed.length,
              total: pool.pool.length,
              n: state.blocked.length,
            })
          : t('supervise.done', { done: state.completed.length, total: pool.pool.length });
      console.log(doneMsg);
      return blockedExitCode();
    }
    if (opts.once && rounds > 0) {
      console.log(t('supervise.onceStop'));
      return blockedExitCode();
    }
    rounds++;
    // 选中即标记进行中(与 next 一致):崩溃后 in_progress 有据,续跑 resume 幂等。
    const selectedId = task.id;
    if (state.in_progress?.id !== selectedId) {
      state.in_progress = { id: selectedId, started_at: isoNow() };
      saveState(state);
    }

    const retryBudget = pool.schedule?.retry_budget ?? 2;
    const before = progressSig(state);
    logLine(t('supervise.roundStart', { round: rounds, remaining: pool.pool.length - state.completed.length }));

    // 先试 --continue 续接主会话;快速失败(如首次无历史会话报错)回退去掉 --continue 新开会话。
    // 超时(宿主长时间运行)不算快速失败,直接计失败,避免每轮吃 2 个完整超时。
    let r = await runHostRound(hr, SUPERVISOR_PROMPT, timeoutMs, true, logLine, onSpawn);
    if (r.code !== 0 && r.elapsedMs < timeoutMs / 2) {
      logLine(t('supervise.fallback'));
      r = await runHostRound(hr, SUPERVISOR_PROMPT, timeoutMs, false, logLine, onSpawn);
    }

    const after = loadState();
    const progressed = progressSig(after) !== before;

    if (r.code !== 0 && !progressed) {
      // 会话失败且无进展:计一次失败,耗尽则阻塞"本轮选中的任务"(不是轮后 in_progress,
      // 它可能是主会话刚 next 出的新任务,从未实现)。
      attempt += 1;
      if (attempt >= retryBudget) {
        logLine(t('supervise.blockFail', { attempt, id: selectedId }));
        blockInProgress(after, selectedId, t('supervise.blockReason', { attempt }));
        attempt = 0;
      } else {
        const wait = backoffSec(attempt);
        logLine(t('supervise.retry', { attempt, wait }));
        await sleep(wait * 1000);
        continue;
      }
    } else {
      // 成功或失败但有进展(超时前完成了任务):不算失败,attempt 清零
      attempt = 0;
    }

    if (!progressed) {
      idleRounds += 1;
      if (shouldStopIdle(idleRounds, opts.maxIdle)) {
        console.log(t('supervise.idleStop', { n: idleRounds }));
        return blockedExitCode();
      }
      logLine(t('supervise.idle', { idleRounds, maxIdle: opts.maxIdle }));
    } else {
      idleRounds = 0;
    }

    await sleep(opts.intervalSec * 1000);
  }
}

export function createSuperviseCommand(): Command {
  return new Command('supervise')
    .description(t('supervise.desc'))
    .option('--interval-sec <n>', t('supervise.intervalSecOption'), (v) => parseInt(v, 10), 10)
    .option('--timeout-min <n>', t('supervise.timeoutMinOption'), (v) => parseInt(v, 10), 30)
    .option('--max-idle <n>', t('supervise.maxIdleOption'), (v) => parseInt(v, 10), 3)
    .option('--once', t('supervise.onceOption'), false)
    .action(async (opts) => {
      // 启动轮转:日志超 10MB 改名 .1 重开,防无人值守整晚膨胀
      rotateLogIfLarge(SUPERVISOR_LOG(), 10 * 1024 * 1024);
      // 每行:写 supervisor.log + 打到 stdout(无人值守时以日志为准)
      const logLine = (l: string): void => {
        const line = `[${fmtDateTime()}] ${l}`;
        fs.mkdirSync(path.dirname(SUPERVISOR_LOG()), { recursive: true });
        fs.appendFileSync(SUPERVISOR_LOG(), `${line}\n`, 'utf8');
        console.log(line);
      };
      // 收到终止信号(SIGINT/SIGTERM)时先结束当前子进程,避免 claude 成孤儿跑到底
      let child: ChildProcess | null = null;
      const onSignal = (): void => {
        if (child) {
          logLine('[signal] 收到终止信号,结束当前轮');
          child.kill('SIGKILL');
        }
        process.exit(130);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const code = await superviseLoop(
        {
          intervalSec: opts.intervalSec,
          timeoutMin: opts.timeoutMin,
          maxIdle: opts.maxIdle,
          once: opts.once,
        },
        logLine,
        undefined,
        (c) => {
          child = c;
        },
      );
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.exitCode = code;
    });
}
