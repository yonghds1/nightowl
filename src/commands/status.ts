import { Command } from 'commander';
import { loadPool, loadState } from '../state.js';
import { t as tr } from '../i18n.js';
import { getPkgVersion } from '../paths.js';
import { loadTemplateHashes } from './install.js';
import { semverLt } from '../util.js';

/** 技能版本自检:返回提示文案(无提示返回 null)。在 summary 后调用,非阻断。 */
export function versionHint(): string | null {
  const rec = loadTemplateHashes();
  if (!rec) return null;
  const pkg = getPkgVersion();
  if (rec.skillsVersion === undefined) return tr('status.skillsUnversioned');
  if (semverLt(rec.skillsVersion, pkg)) {
    return tr('status.skillsOutdated', { installed: rec.skillsVersion, latest: pkg });
  }
  return null;
}

export function createStatusCommand(): Command {
  return new Command('status')
    .description(tr('status.desc'))
    .option('--verbose', tr('status.verboseOption'))
    .action((opts: { verbose: boolean }) => {
      const pool = loadPool();
      if (!pool) {
        console.error(tr('common.noPool'));
        process.exit(1);
      }
      const state = loadState();
      const doneIds = new Set(state.completed.map((c) => c.id));
      const blocked = state.blocked;

      console.log(tr('status.title', { n: pool.pool.length }));
      console.log('─'.repeat(60));
      for (const t of pool.pool) {
        const tid = t.id;
        let mark: string;
        if (doneIds.has(tid)) mark = '✅';
        else if (blocked.some((b) => b.id === tid)) mark = '🚫';
        else mark = '⏳';
        const deps = t.depends_on?.length ? tr('status.deps', { deps: t.depends_on.join(', ') }) : '';
        const assignee = t.assignee ?? tr('status.noAssignee');
        console.log(tr('status.taskLine', { mark, tid, prio: t.priority, title: t.title, est: t.est_min, assignee, deps }));
      }
      console.log('─'.repeat(60));
      console.log(tr('status.summary', { done: doneIds.size, blocked: blocked.length }));
      const hint = versionHint();
      if (hint) console.log(hint);
      if (opts.verbose && blocked.length) {
        console.log(tr('status.blockedTitle'));
        for (const b of blocked) console.log(`  ${b.id}: ${b.reason ?? ''}`);
      }
    });
}
