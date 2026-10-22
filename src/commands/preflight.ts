import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { git, gitInProgressOp, type GitResult } from '../git.js';
import { getBaseDir } from '../paths.js';
import { t } from '../i18n.js';
import { discoverWorkspace } from '../workspace.js';

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  level: CheckLevel;
  message: string;
  fix?: string;
}

/** 统计 worktree 元数据里目录已消失的条目(手工 rm -rf 后的幽灵记录)。 */
function staleWorktrees(out: string): { total: number; stale: number } {
  const paths = out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
  // 第一条永远是主工作区
  const extra = paths.slice(1);
  return { total: extra.length, stale: extra.filter((p) => !fs.existsSync(p)).length };
}

/**
 * 收集环境检查结果。纯执行 + 返回,不打印也不退出,便于单测。
 * strict=true 时把 warn 升级为 fail(无人值守前的强校验)。
 */
export function runPreflight(strict = false): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const promote = (c: PreflightCheck): PreflightCheck =>
    strict && c.level === 'warn' ? { ...c, level: 'fail' } : c;

  const workspace = discoverWorkspace();
  for (const error of workspace.errors) {
    checks.push({ level: 'fail', message: t('workspace.error', { error }) });
  }
  if (fs.existsSync(getBaseDir())) {
    checks.push({ level: 'pass', message: t('preflight.ok.init') });
  } else {
    checks.push({ level: 'fail', message: t('preflight.fail.init'), fix: t('preflight.fix.init') });
  }
  if (workspace.errors.length) return checks;
  checks.push({ level: 'pass', message: t('workspace.mode', { mode: workspace.kind }) });
  if (workspace.kind !== 'single-repo') {
    checks.push({ level: 'pass', message: t('workspace.direct') });
  }
  for (const repoDir of workspace.repositories) {
    try {
      checks.push(...checkRepository(repoDir).map((check) => ({
        ...promote(check),
        message: `[${path.relative(workspace.root, repoDir) || '.'}] ${check.message}`,
      })));
    } catch (error: unknown) {
      checks.push({ level: 'fail', message: t('workspace.error', { error: `${repoDir}: ${(error as Error).message}` }) });
    }
  }
  return checks;
}

/** Every repository operation uses an explicit cwd; no process-wide chdir. */
function checkRepository(cwd: string): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const repoGit = (args: string[], allowedCodes = [0]): GitResult => {
    const result = git(args, { cwd });
    if (!allowedCodes.includes(result.code)) {
      throw new Error(result.stderr || result.stdout || `git ${args.join(' ')}: exit ${result.code}`);
    }
    return result;
  };
  checks.push({ level: 'pass', message: t('preflight.ok.repo') });
  const head = repoGit(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]);
  if (head.code !== 0) checks.push({ level: 'fail', message: t('workspace.noHead') });

  // 分支:detached HEAD 下合并会产生游离提交
  const branch = repoGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
  if (branch.code === 0 && branch.stdout.trim()) {
    checks.push({ level: 'pass', message: t('preflight.ok.branch', { branch: branch.stdout.trim() }) });
  } else {
    checks.push({ level: 'fail', message: t('preflight.fail.branch'), fix: t('preflight.fix.branch') });
  }

  // 未完成的 merge/rebase:此时任何自动化都会踩在半成品状态上
  const op = gitInProgressOp(cwd);
  if (op) {
    checks.push({
      level: 'fail',
      message: t('preflight.fail.merge', { op }),
      fix: t('preflight.fix.merge'),
    });
  } else {
    checks.push({ level: 'pass', message: t('preflight.ok.merge') });
  }

  // 浅克隆:merge-base --is-ancestor 会失真,导致 RESUME/合并判断错误
  const shallow = repoGit(['rev-parse', '--is-shallow-repository']).stdout.trim();
  if (shallow === 'true') {
    checks.push(
      { level: 'warn', message: t('preflight.warn.shallow'), fix: t('preflight.fix.shallow') },
    );
  } else {
    checks.push({ level: 'pass', message: t('preflight.ok.shallow') });
  }

  // 提交身份:容器/CI 常见缺失,报错信息难懂
  const name = repoGit(['config', 'user.name'], [0, 1]).stdout.trim();
  const email = repoGit(['config', 'user.email'], [0, 1]).stdout.trim();
  if (name && email) {
    checks.push({ level: 'pass', message: t('preflight.ok.identity', { name, email }) });
  } else {
    checks.push({
      level: 'fail',
      message: t('preflight.fail.identity'),
      fix: t('preflight.fix.identity'),
    });
  }

  // 工作区脏:合并前必须 clean(列为 warn,避免妨碍日常使用;--strict 下升级)
  const dirty = repoGit(['status', '--porcelain']).stdout.split('\n').filter(Boolean).length;
  if (dirty === 0) {
    checks.push({ level: 'pass', message: t('preflight.ok.dirty') });
  } else {
    checks.push(
      { level: 'warn', message: t('preflight.warn.dirty', { n: dirty }), fix: t('preflight.fix.dirty') },
    );
  }

  // 幽灵 worktree:会让 sweep 永远清不掉、setup 误判
  const wt = staleWorktrees(repoGit(['worktree', 'list', '--porcelain']).stdout);
  if (wt.stale > 0) {
    checks.push(
      {
        level: 'warn',
        message: t('preflight.warn.worktrees', { n: wt.stale }),
        fix: t('preflight.fix.worktrees'),
      },
    );
  } else {
    checks.push({ level: 'pass', message: t('preflight.ok.worktrees', { n: wt.total }) });
  }

  // A parent workspace's state directory is outside the child repository.
  const relativeState = path.relative(cwd, getBaseDir());
  if (relativeState && relativeState !== '..' && !relativeState.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeState)) {
    if (repoGit(['check-ignore', '-q', relativeState], [0, 1]).code === 0) {
      checks.push({ level: 'pass', message: t('preflight.ok.ignored') });
    } else {
      checks.push({ level: 'warn', message: t('preflight.warn.ignored'), fix: t('preflight.fix.ignored') });
    }
  }

  const remotes = repoGit(['remote']).stdout.split(/\s+/).filter(Boolean);
  if (remotes.length) {
    checks.push({ level: 'pass', message: t('preflight.ok.remote', { remotes: remotes.join(', ') }) });
  } else {
    checks.push(
      { level: 'warn', message: t('preflight.warn.remote'), fix: t('preflight.fix.remote') },
    );
  }

  return checks;
}

export function createPreflightCommand(): Command {
  return new Command('preflight')
    .description(t('preflight.desc'))
    .option('--strict', t('preflight.strictOption'), false)
    .action((opts: { strict: boolean }) => {
      const checks = runPreflight(opts.strict);
      console.log(t('preflight.title'));
      for (const c of checks) {
        const icon = c.level === 'pass' ? '✅' : c.level === 'warn' ? '⚠️ ' : '❌';
        console.log(`${icon} ${c.message}`);
        if (c.fix) console.log(`   ↪ ${c.fix}`);
      }
      const failed = checks.filter((c) => c.level === 'fail').length;
      if (failed > 0) {
        console.error(t('preflight.summaryFail', { n: failed }));
        console.error(`PREFLIGHT_FAIL: ${failed}`);
        process.exit(1);
      }
      console.log(t('preflight.summaryOk'));
      console.log('PREFLIGHT_OK');
    });
}
