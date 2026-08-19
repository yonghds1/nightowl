import { Command } from 'commander';
import {
  loadPool,
  loadState,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
} from '../state.js';
import { t } from '../i18n.js';

export function createCheckpointCommand(): Command {
  return new Command('checkpoint')
    .description(t('checkpoint.desc'))
    .argument('<action>', 'save/load/clear/status')
    .action((action: string) => {
      if (action === 'save') {
        const pool = loadPool();
        if (!pool) {
          console.error(t('common.noPool'));
          process.exit(1);
        }
        const state = loadState();
        const total = pool.pool.length;
        const completed = state.completed.length;
        saveCheckpoint(pool, state, { total, completed });
        console.log(t('checkpoint.saved', { completed, total }));
      } else if (action === 'load') {
        const cp = loadCheckpoint();
        if (!cp) {
          console.log(t('checkpoint.none'));
          return;
        }
        console.log(t('checkpoint.infoTitle'));
        console.log(t('checkpoint.updatedAt', { at: cp.updated_at ?? t('checkpoint.unknown') }));
        console.log(t('checkpoint.progress', { completed: cp.stats?.completed ?? 0, total: cp.stats?.total ?? 0 }));
        const completedIds = cp.state.completed.map((c) => c.id);
        const blockedIds = cp.state.blocked.map((b) => b.id);
        console.log(t('checkpoint.completed', { ids: completedIds.join(', ') || t('checkpoint.noneList') }));
        console.log(t('checkpoint.blocked', { ids: blockedIds.join(', ') || t('checkpoint.noneList') }));
      } else if (action === 'clear') {
        clearCheckpoint();
        console.log(t('checkpoint.cleared'));
      } else if (action === 'status') {
        const cp = loadCheckpoint();
        if (!cp) {
          console.log(t('checkpoint.none'));
          console.log('CHECKPOINT_NONE');
          return;
        }
        const completed = cp.stats?.completed ?? 0;
        const total = cp.stats?.total ?? 0;
        const remaining = total - completed;
        console.log(t('checkpoint.statusTitle'));
        console.log(t('checkpoint.updatedAt', { at: cp.updated_at ?? t('checkpoint.unknown') }));
        console.log(t('checkpoint.statusProgress', { completed, total, remaining }));
        if (remaining > 0) console.log(`CHECKPOINT_EXISTS: ${remaining}`);
        else console.log('CHECKPOINT_DONE');
      } else {
        console.error(t('checkpoint.unknownAction', { action }));
        process.exit(1);
      }
    });
}
