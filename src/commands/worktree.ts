import { Command } from 'commander';
import fs, { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { git, gitCurrentBranch, probeGit } from '../git.js';
import { getBaseDir } from '../paths.js';
import { loadPool } from '../state.js';
import { assertTaskId } from '../task-id.js';

export function getWorktreePath(id: string): string {
  return path.join(getBaseDir(), 'worktrees', id);
}

export function getWorktreeBranch(id: string): string {
  return `nightowl/${id}`;
}

/** 校验任务 id;非法时只打印一行错误并退出(不让 Node 调用栈泄漏到 stderr 污染协议输出)。 */
function requireTaskId(id: string): void {
  try {
    assertTaskId(id);
  } catch (err: unknown) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * 确保 .nightowl/ 在本仓库(含所有 linked worktree)被 git 忽略。
 *
 * worktree setup 是从 HEAD commit 建工作树的:如果用户还没把 init 写的 .gitignore 提交,
 * 新 worktree 里就没有忽略规则,子代理/工具只要往 .nightowl/ 落一个文件,
 * cleanup 的 `git status --porcelain` 就会判 WORKTREE_DIRTY 拒绝清理。
 *
 * 写 info/exclude 而不是 .gitignore:它是 $GIT_COMMON_DIR 下、所有 linked worktree 共享的,
 * 且不进工作树 —— 不改用户的提交内容,也不会出现在 git status 里。
 */
function ensureIgnoredInRepo(): void {
  const common = git(['rev-parse', '--git-common-dir']);
  if (common.code !== 0 || !common.stdout.trim()) return; // 非 git 仓库:交给上层报错
  const exclude = path.join(common.stdout.trim(), 'info', 'exclude');
  const entry = '.nightowl/';
  try {
    const cur = existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const lines = cur.split('\n').map((l) => l.trim());
    if (lines.includes(entry) || lines.includes('.nightowl')) return;
    mkdirSync(path.dirname(exclude), { recursive: true });
    const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(exclude, `${cur}${sep}${entry}\n`, 'utf8');
  } catch {
    // 忽略:写不进去也不能挡住 setup 主流程
  }
}

function branchExists(branch: string): boolean {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
}

/** 仓库是否停在未完成的 merge(冲突未解决)。 */
function mergeInProgress(): boolean {
  return git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']).code === 0;
}

/** 未解决的冲突文件列表。 */
function conflictedFiles(): string[] {
  return git(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
}

export function createWorktreeCommand(): Command {
  const cmd = new Command('worktree').description(
    '管理任务隔离工作树(setup / merge / cleanup / list)',
  );

  cmd
    .command('setup')
    .argument('<id>')
    .option('--base <branch>', '基于的分支', undefined)
    .action((id: string, opts: { base?: string }) => {
      requireTaskId(id);
      // 非 git 环境(多仓父目录/普通目录)没有可隔离的对象:降级为无隔离,流程不能断。
      // agent 看到 WORKTREE_SKIPPED 应直接在主目录实现,后续 verify→review→done 照走。
      const env = probeGit();
      if (!env.isRepo) {
        console.log(`WORKTREE_SKIPPED: not a git repo, implement directly in ${process.cwd()}`);
        return;
      }
      const targetDir = getWorktreePath(id);
      const branch = getWorktreeBranch(id);

      // 先回收元数据:手工删过目录的 worktree 仍注册在册,会让后面的 add 报 "already registered"
      git(['worktree', 'prune']);

      if (existsSync(targetDir)) {
        // 自愈孤儿空目录: 若是空目录则安全清理并重建
        try {
          const files = readdirSync(targetDir);
          if (files.length === 0) {
            rmSync(targetDir, { recursive: true, force: true });
          } else {
            console.error(`WORKTREE_EXISTS: ${targetDir}`);
            process.exit(1);
          }
        } catch {
          console.error(`WORKTREE_EXISTS: ${targetDir}`);
          process.exit(1);
        }
      }

      // 先确保 .nightowl/ 在本仓库被忽略,再建 worktree(共享 info/exclude,新 worktree 立即生效)
      ensureIgnoredInRepo();

      const parent = path.dirname(targetDir);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

      const base =
        opts.base?.trim() || git(['rev-parse', 'HEAD']).stdout.trim();
      if (!base) {
        console.error('WORKTREE_SETUP_FAIL: no base commit, empty repo?');
        process.exit(1);
      }

      let r;
      if (branchExists(branch)) {
        r = git(['worktree', 'add', targetDir, branch]);
      } else {
        r = git(['worktree', 'add', '-b', branch, targetDir, base]);
      }
      if (r.code !== 0) {
        console.error(`WORKTREE_SETUP_FAIL: ${r.stderr || r.stdout}`);
        process.exit(1);
      }
      console.log(`WORKTREE_READY: ${targetDir} (branch: ${branch})`);
    });

  cmd
    .command('merge')
    .argument('<id>')
    .option('--no-strict', '跳过 commit 标记检查')
    .action((id: string, opts: { strict: boolean }) => {
      requireTaskId(id);
      // 非 git 环境无分支可合并:跳过即"成功"语义,让调度流程继续走 verify / done
      const env = probeGit();
      if (!env.isRepo) {
        console.log(`WORKTREE_MERGE_SKIPPED: not a git repo (no branch to merge)`);
        return;
      }
      const branch = getWorktreeBranch(id);
      const targetDir = getWorktreePath(id);
      if (!branchExists(branch)) {
        console.error(`WORKTREE_MERGE_FAIL: branch not found: ${branch}`);
        process.exit(1);
      }

      // 合并前置条件:合进一个不干净/游离的 HEAD,失败后会把仓库留在半合并状态。
      const targetBranch = gitCurrentBranch();
      if (!targetBranch) {
        console.error(
          `WORKTREE_DETACHED: 当前处于 detached HEAD,合并会生成游离提交(切换分支后丢失)。\n` +
            `   ↪ 下一步: git switch <集成分支> && nightowl worktree merge ${id}`,
        );
        process.exit(1);
      }
      if (mergeInProgress()) {
        console.error(
          `WORKTREE_MERGE_IN_PROGRESS: 仓库存在未完成的 merge(${targetBranch})。\n` +
            `   ↪ 下一步: git merge --abort(或手工解决冲突后 git commit)\n` +
            `   ↪ 然后重试: nightowl worktree merge ${id}`,
        );
        process.exit(1);
      }
      // 只拦"已跟踪文件的未提交改动":merge 会把它们混入合并结果。
      // 未跟踪文件(如 init 铺入的 .claude/skills)不参与合并,git 自己也会在会被覆盖时拒绝,
      // 一刀切拦下会让 nightowl init 之后的所有合并都无法进行。
      const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout.trim();
      if (dirty) {
        console.error(
          `WORKTREE_MERGE_DIRTY: 当前工作区(${targetBranch})有未提交的已跟踪改动,拒绝合并以免混入或覆盖。\n` +
            `   ↪ 下一步: git status 后 git commit 或 git stash,再重试 nightowl worktree merge ${id}`,
        );
        process.exit(1);
      }

      // 验证回执强校验: 比对当前分支的 HEAD 与验证记录是否一致
      const pool = loadPool();
      const task = pool?.pool.find((t) => t.id === id);
      if (task?.verify?.length && task.verify_passed?.head) {
        const currentBranchHead = git(['rev-parse', branch]).stdout.trim();
        if (currentBranchHead && currentBranchHead !== task.verify_passed.head) {
          console.error(
            `VERIFY_RECORD_STALE: branch ${branch} 的 HEAD 与验证记录不一致(代码发生变动)，请重新运行 nightowl verify --id ${id}`,
          );
          process.exit(1);
        }
      }

      if (opts.strict) {
        const log = git(['log', '-1', '--grep', `\\[#${id}\\]`, branch]);
        if (log.code !== 0 || !log.stdout.trim()) {
          console.error(
            `WORKTREE_MERGE_FAIL: branch ${branch} has no commit tagged [#${id}], aborting.`,
          );
          process.exit(1);
        }
      }
      const r = git([
        'merge',
        '--no-ff',
        '-m',
        `merge: [#${id}] finish in worktree`,
        branch,
      ]);
      if (r.code !== 0) {
        // 冲突:git 会把仓库留在 MERGING 状态。无人值守场景没人来 abort,
        // 自动回滚到合并前,任务由上层按失败降级 blocked。
        if (mergeInProgress()) {
          const files = conflictedFiles();
          git(['merge', '--abort']);
          console.error(
            `WORKTREE_MERGE_CONFLICT: 合并 ${branch} 到 ${targetBranch} 产生冲突,已自动 git merge --abort 回滚。`,
          );
          if (files.length) console.error(`冲突文件:\n${files.map((f) => `  - ${f}`).join('\n')}`);
          console.error(
            `   ↪ 下一步: cd ${targetDir} && git merge ${targetBranch} 解决冲突并 commit,然后重试\n` +
              `   ↪ 或放弃本任务: nightowl block ${id} "merge conflict"`,
          );
          process.exit(1);
        }
        console.error(`WORKTREE_MERGE_FAIL: ${r.stderr || r.stdout}`);
        process.exit(1);
      }
      console.log(`WORKTREE_MERGED: ${branch}`);
    });

  cmd
    .command('cleanup')
    .argument('<id>')
    .option('-f, --force', '彻底清理(含未提交改动)', false)
    .option('--discard', '放弃并彻底清理未提交改动', false)
    .action((id: string, opts: { force: boolean; discard: boolean }) => {
      requireTaskId(id);
      // 非 git 环境 setup 从未建过 worktree:无物可清,直接按"干净"返回
      const env = probeGit();
      if (!env.isRepo) {
        console.log(`WORKTREE_CLEAN_SKIPPED: not a git repo (no worktree was created)`);
        return;
      }
      const targetDir = getWorktreePath(id);
      const branch = getWorktreeBranch(id);
      const isForce = Boolean(opts.force || opts.discard);

      // 安全模式: 若工作区有未提交代码且未显式指定 force/discard, 拒绝删除保留现场
      if (existsSync(targetDir) && !isForce) {
        const statusRes = git(['status', '--porcelain'], { cwd: targetDir });
        if (statusRes.code === 0 && statusRes.stdout.trim()) {
          console.error(
            `WORKTREE_DIRTY: ${targetDir} 存在未提交修改，已保留现场以防代码丢失。\n   ↪ 如确认放弃代码并清理，请运行: nightowl worktree cleanup ${id} --discard`,
          );
          process.exit(1);
        }
      }

      const forceArgs = isForce ? ['--force'] : [];
      const r = git(['worktree', 'remove', ...forceArgs, targetDir]);
      if (r.code !== 0 && existsSync(targetDir)) {
        if (isForce) {
          rmSync(targetDir, { recursive: true, force: true });
        } else {
          console.error(`WORKTREE_CLEANUP_FAIL: ${r.stderr || r.stdout}`);
          process.exit(1);
        }
      }
      if (branchExists(branch)) {
        const branchDeleteArg = isForce ? '-D' : '-d';
        const rm = git(['branch', branchDeleteArg, branch]);
        if (rm.code !== 0) {
          // -d 拒绝(仍有未合入提交)时,强删模式再试一次;仍失败要告知,别让分支悄悄堆积
          const hard = isForce ? git(['branch', '-D', branch]) : rm;
          if (hard.code !== 0) {
            console.error(
              `[warn] 分支 ${branch} 未删除(仍有未合并提交?),保留分支: ${hard.stderr || hard.stdout}`,
            );
          }
        }
      }
      console.log(`WORKTREE_CLEANED: ${id}`);
    });

  cmd
    .command('list')
    .action(() => {
      const env = probeGit();
      if (!env.isRepo) {
        console.log('WORKTREE_EMPTY');
        return;
      }
      const r = git(['worktree', 'list', '--porcelain']);
      if (r.code !== 0) {
        console.error(`WORKTREE_LIST_FAIL: ${r.stderr || r.stdout}`);
        process.exit(1);
      }
      const wts: { path: string; branch: string }[] = [];
      let curPath: string | null = null;
      for (const raw of r.stdout.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length);
        else if (line.startsWith('branch refs/heads/') && curPath) {
          const branch = line.slice('branch refs/heads/'.length);
          if (branch.startsWith('nightowl/')) wts.push({ path: curPath, branch });
        }
      }
      if (!wts.length) {
        console.log('WORKTREE_EMPTY');
        return;
      }
      for (const w of wts) {
        console.log(`${w.branch.slice('nightowl/'.length)}\t${w.branch}\t${path.resolve(w.path)}`);
      }
    });

  return cmd;
}
