import { Command } from 'commander';
import { runShell } from '../git.js';
import { loadPool, savePool } from '../state.js';
import { isoNow } from '../util.js';
import { t } from '../i18n.js';

export function createVerifyCommand(): Command {
  return new Command('verify')
    .description(t('verify.desc'))
    .argument('<id>')
    .action((id: string) => {
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
      const cmds = task.verify ?? [];
      if (!cmds.length) {
        console.log('VERIFY_NONE');
        return;
      }
      for (const c of cmds) {
        const r = runShell(c);
        if (r.code !== 0) {
          const tail = `${r.stdout}\n${r.stderr}`.trim().slice(-500);
          console.error(t('verify.failed', { id, code: r.code, cmd: c }));
          if (tail) console.error(tail);
          process.exit(1);
        }
      }
      task.verify_passed = { at: isoNow(), commands: cmds };
      savePool(pool);
      console.log('ALL_PASS');
    });
}
