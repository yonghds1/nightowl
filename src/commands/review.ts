import { Command } from 'commander';
import { loadPool, updatePool, log } from '../state.js';
import { isoNow } from '../util.js';
import { verificationEvidence } from '../evidence.js';
import { t } from '../i18n.js';

export function createReviewCommand(): Command {
  return new Command('review')
    .description(t('review.desc'))
    .argument('<id>')
    .requiredOption('--result <result>', 'PASS/FAIL/PASS_WITH_NITS')
    .option('--level <level>', t('review.levelOption'), 'full')
    .option('--note <note>', t('review.noteOption'))
    .action((id: string, opts: { result: string; level: string; note?: string }) => {
      const pool = loadPool();
      if (!pool) {
        console.error(t('common.noPool'));
        process.exit(1);
      }
      const task = pool.pool.find((t) => t.id === id);
      if (!task) {
        console.error(t('common.taskNotFound', { id }));
        process.exit(1);
      }
      // 审查历史:已有审查记录则先压入 history 再覆盖(保留多轮评审过程)
      const applied = updatePool((pool) => {
        const target = pool.pool.find((x) => x.id === id);
        if (!target) return false;
        if (target.review) {
          const history = target.review_history ?? [];
          history.push(target.review);
          target.review_history = history;
        }
        target.review = {
          result: opts.result, level: opts.level, note: opts.note ?? '', at: isoNow(),
          ...(verificationEvidence(target) === 'valid' ? { verify_run_id: target.verification_run?.id } : {}),
        };
        return true;
      });
      if (!applied) {
        console.error(t('common.taskNotFound', { id }));
        process.exit(1);
      }
      log(t('review.log', { id, result: opts.result, level: opts.level, note: opts.note ?? '' }));
      console.log(t('review.ok', { result: opts.result }));
    });
}
