import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../git.js';
import { getBaseDir } from '../paths.js';
import { t } from '../i18n.js';

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  level: CheckLevel;
  message: string;
  fix?: string;
}

/** 未完成的 git 操作标记(合并/变基/拣选/回滚),存在任一都不该继续自动化。 */
const IN_PROGRESS: { marker: string; op: string }[] = [
  { marker: 'MERGE_HEAD', op: 'merge' },
  { marker: 'rebase-merge', op: 'rebase' },
  { marker: 'rebase-apply', op: 'rebase' },
  { marker: 'CHERRY_PICK_HEAD', op: 'cherry-pick' },
  { marker: 'REVERT_HEAD', op: 'revert' },
];

/** git 元数据路径(兼容 linked worktree:`--git-path` 会返回正确的 per-worktree 路径)。 */
function gitPath(name: string): string | null {
  const r = git(['rev-parse', '--git-path', name]);
  return r.code === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}

function inProgressOp(): string | null {
  for (const { marker, op } of IN_PROGRESS) {
    const p = gitPath(marker);
    if (p && fs.existsSync(p)) return op;
  }
  return null;
}

/** 统计 worktree 元数据里目录已消失的条目(手工 rm -rf 后的幽灵记录)。 */
function staleWorktrees(): { total: number; stale: number } {
  const out = git(['worktree', 'list', '--porcelain']).stdout;
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

  const repo = git(['rev-parse', '--git-dir']);
  if (repo.code !== 0) {
    return [
      {
        level: 'fail',
        message: t('preflight.fail.repo'),
        fix: t('preflight.fix.repo'),
      },
    ];
  }
  checks.push({ level: 'pass', message: t('preflight.ok.repo') });

  // .nightowl/ 初始化:getBaseDir 找不到时返回 fallback 路径,用 existsSync 判定
  if (fs.existsSync(getBaseDir())) {
    checks.push({ level: 'pass', message: t('preflight.ok.init') });
  } else {
    checks.push({ level: 'fail', message: t('preflight.fail.init'), fix: t('preflight.fix.init') });
  }

  // 分支:detached HEAD 下合并会产生游离提交
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code === 0 && branch.stdout.trim()) {
    checks.push({ level: 'pass', message: t('preflight.ok.branch', { branch: branch.stdout.trim() }) });
  } else {
    checks.push({ level: 'fail', message: t('preflight.fail.branch'), fix: t('preflight.fix.branch') });
  }

  // 未完成的 merge/rebase:此时任何自动化都会踩在半成品状态上
  const op = inProgressOp();
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
  const shallow = git(['rev-parse', '--is-shallow-repository']).stdout.trim();
  if (shallow === 'true') {
    checks.push(
      promote({ level: 'warn', message: t('preflight.warn.shallow'), fix: t('preflight.fix.shallow') }),
    );
  } else {
    checks.push({ level: 'pass', message: t('preflight.ok.shallow') });
  }

  // 提交身份:容器/CI 常见缺失,报错信息难懂
  const name = git(['config', 'user.name']).stdout.trim();
  const email = git(['config', 'user.email']).stdout.trim();
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
  const dirty = git(['status', '--porcelain']).stdout.split('\n').filter(Boolean).length;
  if (dirty === 0) {
    checks.push({ level: 'pass', message: t('preflight.ok.dirty') });
  } else {
    checks.push(
      promote({ level: 'warn', message: t('preflight.warn.dirty', { n: dirty }), fix: t('preflight.fix.dirty') }),
    );
  }

  // 幽灵 worktree:会让 sweep 永远清不掉、setup 误判
  const wt = staleWorktrees();
  if (wt.stale > 0) {
    checks.push(
      promote({
        level: 'warn',
        message: t('preflight.warn.worktrees', { n: wt.stale }),
        fix: t('preflight.fix.worktrees'),
      }),
    );
  } else {
    checks.push({ level: 'pass', message: t('preflight.ok.worktrees', { n: wt.total }) });
  }

  // .nightowl/ 未忽略:状态/日志会被误提交
  if (git(['check-ignore', '-q', '.nightowl']).code === 0) {
    checks.push({ level: 'pass', message: t('preflight.ok.ignored') });
  } else {
    checks.push(
      promote({ level: 'warn', message: t('preflight.warn.ignored'), fix: t('preflight.fix.ignored') }),
    );
  }

  const remotes = git(['remote']).stdout.split(/\s+/).filter(Boolean);
  if (remotes.length) {
    checks.push({ level: 'pass', message: t('preflight.ok.remote', { remotes: remotes.join(', ') }) });
  } else {
    checks.push(
      promote({ level: 'warn', message: t('preflight.warn.remote'), fix: t('preflight.fix.remote') }),
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
