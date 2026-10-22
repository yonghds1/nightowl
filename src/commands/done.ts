import { Command } from 'commander';
import path from 'node:path';
import {
  loadPool,
  loadState,
  updatePool,
  updateState,
  log,
  saveCheckpoint,
  shouldCheckpoint,
} from '../state.js';
import { taskCommitInHead } from './next.js';
import { probeGit } from '../git.js';
import { backfillPrd } from '../prd.js';
import { resolvePlatform } from '../platforms/index.js';
import { getBaseDir } from '../paths.js';
import { isoNow, minutesBetween } from '../util.js';
import { t } from '../i18n.js';

export function createDoneCommand(): Command {
  return new Command('done')
    .description(t('done.desc'))
    .argument('<id>')
    .argument('[actual_min]', t('done.actualMinArg'), (v: string) => parseInt(v, 10))
    .option('--force', t('done.forceOption'))
    .option('--require-commit', t('done.requireCommitOption'))
    .action((id: string, actualMin: number | undefined, opts: { force: boolean; requireCommit?: boolean }) => {
      const pool = loadPool();
      if (!pool) {
        console.error(t('common.noPool'));
        process.exit(1);
      }
      const state = loadState();
      const task = pool.pool.find((t) => t.id === id);
      if (!task) {
        console.error(t('common.taskNotFound', { id }));
        process.exit(1);
      }
      if (state.completed.some((c) => c.id === id)) {
        console.log(t('done.alreadyDone', { id }));
        return;
      }
      if (!opts.force) {
        // 审查关口:仅 PASS / PASS_WITH_NITS 放行
        const result = task.review?.result;
        if (result !== 'PASS' && result !== 'PASS_WITH_NITS') {
          if (result === 'FAIL') {
            console.error(t('done.reviewFail', { id }));
            console.error(t('done.reviewFailHint'));
          } else {
            console.error(t('done.noReview', { id }));
            console.error(t('done.noReviewHint'));
          }
          process.exit(1);
        }
        // 测试关口:有 verify 命令的任务必须 verify_passed
        if (task.verify?.length && !task.verify_passed) {
          console.error(t('done.noVerify', { id }));
          console.error(t('done.noVerifyHint'));
          process.exit(1);
        }
        // git 硬核验:主分支 HEAD 应存在含 `[#<id>]` 标记的 commit(证明确实实现并合并了,
        // 而非仅靠模型自报 review/verify 状态)。claude 默认只警告(不破坏既有无人值守流程),
        // 新平台默认阻断;--require-commit 让所有平台都阻断。--force 已整体旁路本块。
        // 非 git 环境(多仓父目录)没有统一主分支,commit 门禁整体跳过 —— 任务实现落在子仓,
        // 用夜 verify 命令与 review 把关,不在这里误报 noCommit 阻塞任务。
        if (probeGit().isRepo && !taskCommitInHead(id)) {
          const platform = resolvePlatform(undefined, path.dirname(getBaseDir()));
          const strict = opts.requireCommit === true || platform.id !== 'claude';
          if (strict) {
            console.error(t('done.noCommit', { id }));
            console.error(t('done.noCommitHint'));
            process.exit(1);
          }
          console.log(t('done.noCommitWarn', { id }));
        }
      }
      // actual_min 优先级:显式参数 > in_progress.started_at 实测 > 预估兜底。
      // 不实测的话"工时偏差"永远是 0%,报告看板形同虚设。
      let measuredActual: number;
      if (actualMin === undefined || Number.isNaN(actualMin)) {
        const startedAt = state.in_progress?.id === id ? state.in_progress.started_at : undefined;
        measuredActual = (startedAt ? minutesBetween(startedAt) : null) ?? task.est_min ?? 15;
      } else {
        measuredActual = actualMin;
      }

      // 事务化写回:verify/review 在 done 执行期间完成的修改不会被陈旧快照覆盖
      const applied = updatePool((fresh) => {
        const target = fresh.pool.find((x) => x.id === id);
        if (!target) return false;
        target.status = 'done';
        target.actual_min = measuredActual;
        return true;
      });
      if (!applied) {
        console.error(t('done.persistFailed', { id }));
        process.exit(1);
      }
      const finishedAt = isoNow();
      updateState((fresh) => {
        if (!fresh.completed.some((c) => c.id === id)) {
          fresh.completed.push({ id, actual_min: measuredActual, finished_at: finishedAt });
        }
        fresh.in_progress = null;
      });

      const checkpointCfg = pool.checkpoint ?? { enabled: true, write_every: 1 };
      const interval = checkpointCfg.write_every ?? 1;
      const freshPool = loadPool() ?? pool;
      const freshState = loadState();
      if ((checkpointCfg.enabled ?? true) && shouldCheckpoint(freshState, interval)) {
        const total = freshPool.pool.length;
        const completed = freshState.completed.length;
        saveCheckpoint(freshPool, freshState, { total, completed });
        log(t('checkpoint.savedLog', { completed, total }));
      }

      // PRD 回填放在状态落盘之后:即使回填失败,任务状态也已持久化,不会出现
      // "任务没完成但文档已写完成"的错位。回填本身绝不让 done 失败。
      const commit = probeGit().isRepo ? taskCommitInHead(id) : null;
      const bf = backfillPrd(
        task.prd_path,
        { ...task, status: 'done' },
        measuredActual,
        finishedAt,
        commit,
      );
      if (bf.changed) {
        log(t('done.prdBackfilled', { id, n: bf.checkedCommands }));
      } else if (bf.skipped && bf.skipped !== 'no-prd') {
        log(t('done.prdBackfillSkipped', { id, reason: bf.skipped }));
      }

      log(t('done.completedLog', { id, actual: measuredActual }));
      console.log(t('done.ok', { id }));
    });
}
