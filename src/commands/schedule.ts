import { Command } from 'commander';
import { loadPool, savePool } from '../state.js';
import { t } from '../i18n.js';

export function createScheduleCommand(): Command {
  return new Command('schedule')
    .description(t('schedule.desc'))
    .option('--retry-budget <n>', t('schedule.retryOption'), (v: string) => parseInt(v, 10))
    .action((opts: { retryBudget?: number }) => {
      const pool = loadPool();
      if (!pool) {
        console.error(t('common.noPool'));
        process.exit(1);
      }
      if (opts.retryBudget !== undefined) pool.schedule.retry_budget = opts.retryBudget;
      savePool(pool);
      console.log(t('schedule.ok', { retry: pool.schedule.retry_budget }));
    });
}
