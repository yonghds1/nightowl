import { Command } from 'commander';
import { git } from '../git.js';
import { t } from '../i18n.js';

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null = detached
}

/** 解析 `git worktree list --porcelain`:空行分隔块,每块 = worktree 行 + HEAD + (branch|detached)。 */
function parsePorcelain(out: string): WorktreeInfo[] {
  const wts: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (cur) {
        wts.push(cur as WorktreeInfo);
        cur = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      cur!.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      cur!.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      cur!.branch = null;
    }
  }
  if (cur) wts.push(cur as WorktreeInfo);
  return wts;
}

export function createSweepCommand(): Command {
  return new Command('sweep')
    .description(t('sweep.desc'))
    .action(() => {
      const wt = git(['worktree', 'list', '--porcelain']);
      if (wt.code !== 0) {
        console.log('SWEEP_CLEAN');
        return;
      }
      const repoRoot = git(['rev-parse', '--show-toplevel']).stdout;
      let found = false;
      for (const w of parsePorcelain(wt.stdout)) {
        // 主 worktree 与未诞生(HEAD 全 0)的 worktree 无可判定 commit,跳过
        if (w.path === repoRoot) continue;
        if (!w.head || w.head === '0'.repeat(40)) continue;
        found = true;
        const ref = w.branch ?? w.head; // detached 用 commit hash 标识
        const cherry = git(['cherry', 'HEAD', ref]).stdout;
        const unmerged = cherry
          .split('\n')
          .filter((ln) => ln.startsWith('+'))
          .map((ln) => ln.split(/\s+/)[0])
          .join(',');
        console.log(`${w.branch ?? w.head}\t${w.path}\t${unmerged}`);
      }
      if (!found) console.log('SWEEP_CLEAN');
    });
}
