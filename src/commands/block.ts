import { Command } from 'commander';
import {
  loadPool,
  loadState,
  savePool,
  saveState,
  log,
  saveCheckpoint,
} from '../state.js';
import { isoNow } from '../util.js';
import { t } from '../i18n.js';

export function createBlockCommand(): Command {
  return new Command('block')
    .description(t('block.desc'))
    .argument('<id>')
    .argument('<reason>')
    .action((id: string, reason: string) => {
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
      task.status = 'blocked';
      savePool(pool);
      state.blocked.push({ id, reason, blocked_at: isoNow() });
      state.in_progress = null;
      saveState(state);
      const checkpointCfg = pool.checkpoint ?? { enabled: true, write_every: 1 };
      if (checkpointCfg.enabled ?? true) {
        const total = pool.pool.length;
        const completed = state.completed.length;
        saveCheckpoint(pool, state, { total, completed });
        log(t('checkpoint.savedBlocked'));
      }
      log(t('block.log', { id, reason }));
      console.log(t('block.ok', { id }));
    });
}
