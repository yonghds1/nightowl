import { Command } from 'commander';
import { loadCheckpoint, loadPool, loadState, savePool, saveState, log } from '../state.js';
import { t } from '../i18n.js';

export function createResumeCommand(): Command {
  return new Command('resume')
    .description(t('resume.desc'))
    .action(() => {
      const cp = loadCheckpoint();
      if (!cp) {
        console.log(t('resume.noCheckpoint'));
        console.log('NO_CHECKPOINT');
        return;
      }
      const pool = cp.pool;
      const state = cp.state;
      if (!pool || !state) {
        console.error(t('resume.corrupt'));
        process.exit(1);
      }
      savePool(pool);
      saveState(state);
      const completed = state.completed.length;
      const total = pool.pool.length;
      const ip = state.in_progress;
      log(t('resume.log', { completed, total }));
      console.log(t('resume.ok', { completed, total }));
      if (ip?.id) {
        console.log(t('resume.inProgress', { id: ip.id }));
      } else {
        console.log(t('resume.noInProgress'));
      }
      console.log('RESUMED');
    });
}
