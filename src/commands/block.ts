import { Command } from 'commander';
import {
  loadPool,
  loadState,
  updatePool,
  updateState,
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
      const task = pool.pool.find((t) => t.id === id);
      if (!task) {
        console.error(t('common.taskNotFound', { id }));
        process.exit(1);
      }
      const blockedAt = isoNow();
      const applied = updatePool((fresh) => {
        const target = fresh.pool.find((x) => x.id === id);
        if (!target) return false;
        target.status = 'blocked';
        return true;
      });
      if (!applied) {
        console.error(t('common.taskNotFound', { id }));
        process.exit(1);
      }
      updateState((fresh) => {
        fresh.blocked.push({ id, reason, blocked_at: blockedAt });
        fresh.in_progress = null;
      });

      const freshPool = loadPool() ?? pool;
      const freshState = loadState();
      const checkpointCfg = freshPool.checkpoint ?? { enabled: true, write_every: 1 };
      if (checkpointCfg.enabled ?? true) {
        const total = freshPool.pool.length;
        const completed = freshState.completed.length;
        saveCheckpoint(freshPool, freshState, { total, completed });
        log(t('checkpoint.savedBlocked'));
      }
      log(t('block.log', { id, reason }));
      console.log(t('block.ok', { id }));
    });
}
