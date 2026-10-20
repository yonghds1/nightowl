import { Command } from 'commander';
import { git, probeGit } from '../git.js';
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
    .option('--clean', '真正删除已合入且无未提交改动的残留 worktree(默认只报告)')
    .action((opts: { clean?: boolean }) => {
      // 非 git 环境从未建过 worktree,现场视为干净(run.md 流程里 SWEEP_CLEAN 即继续)
      if (!probeGit().isRepo) {
        console.log('SWEEP_CLEAN');
        return;
      }
      const wt = git(['worktree', 'list', '--porcelain']);
      if (wt.code !== 0) {
        console.error(`SWEEP_FAIL: git worktree list failed: ${wt.stderr || wt.stdout}`);
        process.exit(1);
      }
      const topLevel = git(['rev-parse', '--show-toplevel']);
      if (topLevel.code !== 0) {
        console.error(`SWEEP_FAIL: git rev-parse failed: ${topLevel.stderr || topLevel.stdout}`);
        process.exit(1);
      }
      const repoRoot = topLevel.stdout;
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

        if (!opts.clean) continue;

        // --clean 的安全边界:只有"无未合入 commit"且"无未提交改动"才删。
        // 任一条件不满足都保留现场 —— 清理是便利功能,绝不拿代码冒险。
        if (unmerged) {
          console.log(`SWEEP_KEEP_UNMERGED: ${w.path}`);
          continue;
        }
        const st = git(['status', '--porcelain'], { cwd: w.path });
        if (st.code !== 0) {
          console.log(`SWEEP_KEEP_UNKNOWN: ${w.path}`);
          continue;
        }
        if (st.stdout.trim()) {
          console.log(`SWEEP_KEEP_DIRTY: ${w.path}`);
          continue;
        }
        const rm = git(['worktree', 'remove', w.path]);
        if (rm.code !== 0) {
          console.log(`SWEEP_REMOVE_FAIL: ${w.path}: ${rm.stderr || rm.stdout}`);
          continue;
        }
        // 分支已合入,用 -d(安全删除)而非 -D
        if (w.branch) git(['branch', '-d', w.branch]);
        console.log(`SWEEP_REMOVED: ${w.path}`);
      }
      if (!found) console.log('SWEEP_CLEAN');
    });
}
