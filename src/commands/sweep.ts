import { Command } from 'commander';
import { git, gitCurrentBranch, probeGit } from '../git.js';
import { t } from '../i18n.js';

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null = detached
  locked: boolean;
}

/** 解析 `git worktree list --porcelain`:空行分隔块,每块 = worktree 行 + HEAD + (branch|detached|locked)。 */
function parsePorcelain(out: string): WorktreeInfo[] {
  const wts: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> | null = null;

  const flush = (): void => {
    if (cur?.path) {
      wts.push({
        path: cur.path,
        head: cur.head ?? '',
        branch: cur.branch ?? null,
        locked: cur.locked ?? false,
      });
    }
    cur = null;
  };

  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length), locked: false };
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      if (cur) cur.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      if (cur) cur.branch = null;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      if (cur) cur.locked = true;
    }
  }
  flush();
  return wts;
}

export interface MergeState {
  merged: boolean;
  /** 未合入的 commit(空表示已合入/全部 patch 等价)。 */
  unmerged: string[];
}

/**
 * 判断 ref 是否已合入 base:
 *  1) ancestry(`merge-base --is-ancestor`):普通 merge 与 fast-forward;
 *  2) patch-id 等价(`git cherry`):cherry-pick / rebase / 单提交 squash 后,
 *     原 commit 不是 base 祖先,但内容已在 base 里。
 * 只用 cherry 会漏掉 merge commit(它不参与 patch-id),只用 ancestry 会漏掉 squash。
 */
export function mergeState(ref: string, base = 'HEAD'): MergeState {
  if (git(['merge-base', '--is-ancestor', ref, base]).code === 0) {
    return { merged: true, unmerged: [] };
  }
  const lines = git(['cherry', base, ref]).stdout.split('\n').filter(Boolean);
  const unmerged = lines
    .filter((ln) => ln.startsWith('+'))
    .map((ln) => ln.split(/\s+/)[0]);
  // 没有 '+' 且至少一行 '-':全部 commit 都有等价 patch,可安全清理
  if (unmerged.length === 0 && lines.length > 0) return { merged: true, unmerged: [] };
  return { merged: false, unmerged };
}

function localBranchExists(branch: string): boolean {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
}

/**
 * 解析"集成分支":--base → 本地 main/master → origin/HEAD → 当前分支。
 * sweep 不能用当前 HEAD 硬编码:在 feature 分支上跑会把所有任务分支误判成未合入。
 */
export function resolveBaseBranch(explicit?: string): string | null {
  if (explicit?.trim()) return explicit.trim();

  for (const name of ['main', 'master']) {
    if (localBranchExists(name)) return name;
  }

  const originHead = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead.code === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^refs\/remotes\//, '');
  }

  return gitCurrentBranch();
}

export function createSweepCommand(): Command {
  return new Command('sweep')
    .description(t('sweep.desc'))
    .option('--clean', t('sweep.cleanOption'))
    .option(
      '--base <branch>',
      '以该分支为集成分支判定已合入(默认 main/master → origin/HEAD → 当前分支)',
    )
    .action((opts: { clean?: boolean; base?: string }) => {
      // 非 git 环境从未建过 worktree,现场视为干净(run.md 流程里 SWEEP_CLEAN 即继续)
      if (!probeGit().isRepo) {
        console.log('SWEEP_CLEAN');
        return;
      }

      // 先回收幽灵元数据:目录被手工删过的 worktree 不 prune 会永远清不掉,
      // 后面每个命令都会对着不存在的 cwd 失败。
      git(['worktree', 'prune']);

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

      // 空仓库(还没有任何 commit):没有可判定的分支,直接报干净
      if (git(['rev-parse', '--verify', '--quiet', 'HEAD']).code !== 0) {
        console.log('SWEEP_CLEAN');
        return;
      }

      const base = resolveBaseBranch(opts.base);
      if (!base) {
        console.error('SWEEP_FAIL: 无法确定集成分支,请用 --base <branch> 指定');
        process.exit(1);
      }
      if (git(['rev-parse', '--verify', '--quiet', base]).code !== 0) {
        console.error(`SWEEP_FAIL: 集成分支不存在: ${base}`);
        process.exit(1);
      }
      // 诊断信息走 stderr,保持 stdout 的机器协议只有 "ref\tpath\tunmerged" 行
      console.error(`SWEEP_BASE: ${base}`);

      let found = false;
      for (const w of parsePorcelain(wt.stdout)) {
        // 主 worktree 与未诞生(HEAD 全 0)的 worktree 无可判定 commit,跳过
        if (w.path === repoRoot) continue;
        if (!w.head || /^0+$/.test(w.head)) continue;
        found = true;
        const ref = w.branch ?? w.head; // detached 用 commit hash 标识
        const state = mergeState(ref, base);
        console.log(`${ref}\t${w.path}\t${state.unmerged.join(',')}`);

        if (!opts.clean) continue;

        // --clean 的安全边界:只有"无未合入 commit"且"无未提交改动"才删。
        // 任一条件不满足都保留现场 —— 清理是便利功能,绝不拿代码冒险。
        if (w.locked) {
          console.log(`SWEEP_KEEP_LOCKED: ${w.path}`);
          continue;
        }
        if (!state.merged) {
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
        // 分支已确认合入:先 -d(安全删除),失败再 -D(已由 mergeState 证明内容在 base 里);
        // 两者都失败必须可见,否则分支会悄悄堆积。
        if (w.branch) {
          let br = git(['branch', '-d', w.branch]);
          if (br.code !== 0) br = git(['branch', '-D', w.branch]);
          if (br.code !== 0) {
            console.error(t('sweep.branchKeep', { branch: w.branch, err: br.stderr || br.stdout }));
          }
        }
        console.log(`SWEEP_REMOVED: ${w.path}`);
      }
      if (!found) console.log('SWEEP_CLEAN');
    });
}
