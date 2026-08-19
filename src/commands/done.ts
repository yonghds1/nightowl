import { Command } from 'commander';
import {
  loadPool,
  loadState,
  savePool,
  saveState,
  log,
  saveCheckpoint,
  shouldCheckpoint,
} from '../state.js';
import { isoNow } from '../util.js';
import { t } from '../i18n.js';

export function createDoneCommand(): Command {
  return new Command('done')
    .description(t('done.desc'))
    .argument('<id>')
    .argument('<actual_min>', t('done.actualMinArg'), (v: string) => parseInt(v, 10))
    .option('--force', t('done.forceOption'))
    .action((id: string, actualMin: number, opts: { force: boolean }) => {
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
      }
      task.status = 'done';
      task.actual_min = actualMin;
      savePool(pool);
      state.completed.push({ id, actual_min: actualMin, finished_at: isoNow() });
      state.in_progress = null;
      saveState(state);

      const checkpointCfg = pool.checkpoint ?? { enabled: true, write_every: 1 };
      const interval = checkpointCfg.write_every ?? 1;
      if ((checkpointCfg.enabled ?? true) && shouldCheckpoint(state, interval)) {
        const total = pool.pool.length;
        const completed = state.completed.length;
        saveCheckpoint(pool, state, { total, completed });
        log(t('checkpoint.savedLog', { completed, total }));
      }

      log(t('done.completedLog', { id, actual: actualMin }));
      console.log(t('done.ok', { id }));
    });
}
