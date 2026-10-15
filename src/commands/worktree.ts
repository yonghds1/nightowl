import { Command } from 'commander';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { git } from '../git.js';
import { getBaseDir } from '../paths.js';

export function getWorktreePath(id: string): string {
  return path.join(getBaseDir(), 'worktrees', id);
}

export function getWorktreeBranch(id: string): string {
  return `nightowl/${id}`;
}

function branchExists(branch: string): boolean {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
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
      const targetDir = getWorktreePath(id);
      const branch = getWorktreeBranch(id);
      if (existsSync(targetDir)) {
        console.error(`WORKTREE_EXISTS: ${targetDir}`);
        return;
      }
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
      const branch = getWorktreeBranch(id);
      if (!branchExists(branch)) {
        console.error(`WORKTREE_MERGE_FAIL: branch not found: ${branch}`);
        process.exit(1);
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
        console.error(`WORKTREE_MERGE_FAIL: ${r.stderr || r.stdout}`);
        process.exit(1);
      }
      console.log(`WORKTREE_MERGED: ${branch}`);
    });

  cmd
    .command('cleanup')
    .argument('<id>')
    .option('-f, --force', '彻底清理(含未提交改动)', true)
    .action((id: string, opts: { force: boolean }) => {
      const targetDir = getWorktreePath(id);
      const branch = getWorktreeBranch(id);
      const forceArgs = opts.force ? ['--force'] : [];
      const r = git(['worktree', 'remove', ...forceArgs, targetDir]);
      if (r.code !== 0 && existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      if (branchExists(branch)) {
        const rm = git(['branch', '-D', branch]);
        if (rm.code !== 0) {
          console.error(`WORKTREE_CLEANUP_FAIL: ${rm.stderr || rm.stdout}`);
          process.exit(1);
        }
      }
      console.log(`WORKTREE_CLEANED: ${id}`);
    });

  cmd
    .command('list')
    .action(() => {
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
