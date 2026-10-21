import { Command } from 'commander';
import { git, gitCurrentBranch, gitInProgressOp } from '../git.js';
import { loadPool } from '../state.js';
import { assertTaskId } from '../task-id.js';
import { t } from '../i18n.js';

/** 缺 `[#id]` 标记时补到标题行首;已有的不重复添加。 */
export function ensureTaskMarker(message: string, id: string): string {
  const marker = `[#${id}]`;
  if (message.includes(marker)) return message;
  const [subject = '', ...rest] = message.split('\n');
  return [`${marker} ${subject}`.trim(), ...rest].join('\n');
}

/** 提取 message 里已有的任务标记(用于拦截提交到别的任务)。 */
export function taskMarkers(message: string): string[] {
  return [...message.matchAll(/\[#([A-Za-z0-9_-]+)\]/g)].map((m) => m[1]);
}

function fail(msg: string): never {
  console.error(msg);
  console.error('COMMIT_FAIL');
  process.exit(1);
}

interface CommitOptions {
  task: string;
  message: string;
  all: boolean;
  verify: boolean;
  sign: boolean;
  allowEmpty: boolean;
}

/**
 * 规范化提交:把"commit message 必须带 [#id]"从提示词约定变成机制保证。
 * 默认禁用 GPG 签名与编辑器/终端提示,避免无人值守时卡在口令或编辑器上。
 */
export function createCommitCommand(): Command {
  return new Command('commit')
    .description(t('commit.desc'))
    .requiredOption('--task <id>', t('commit.taskOption'))
    .requiredOption('-m, --message <message>', t('commit.messageOption'))
    .option('-a, --all', t('commit.allOption'), false)
    .option('--no-verify', t('commit.noVerifyOption'))
    .option('--sign', t('commit.signOption'), false)
    .option('--allow-empty', t('commit.allowEmptyOption'), false)
    .action((opts: CommitOptions) => {
      const id = opts.task.trim();
      try {
        assertTaskId(id);
      } catch (err: unknown) {
        fail((err as Error).message);
      }

      if (!gitCurrentBranch()) fail(t('commit.detached'));
      const op = gitInProgressOp();
      if (op) fail(t('commit.inProgress', { op }));

      const name = git(['config', 'user.name']).stdout.trim();
      const email = git(['config', 'user.email']).stdout.trim();
      if (!name || !email) fail(t('commit.noIdentity'));

      const pool = loadPool();
      if (!pool) fail(t('common.noPool'));
      if (!pool.pool.some((task) => task.id === id)) fail(t('common.taskNotFound', { id }));

      // 已有别的任务标记 → 拒绝,避免把 A 的改动挂到 B 的提交上(会让 done 门禁错乱)
      const other = taskMarkers(opts.message).find((m) => m !== id);
      if (other) fail(t('commit.wrongTask', { id, found: other }));

      if (opts.all) {
        const add = git(['add', '-A']);
        if (add.code !== 0) fail(t('commit.stageFailed', { err: add.stderr || add.stdout }));
      }

      // 默认只提交已暂存内容;没暂存任何东西时给出可执行提示,而不是让 git 报空洞错误
      if (!opts.allowEmpty) {
        const staged = git(['diff', '--cached', '--quiet']);
        if (staged.code === 0) fail(t('commit.nothing', { id }));
        if (staged.code !== 1) fail(t('commit.failed', { err: staged.stderr || staged.stdout }));
      }

      const args = ['commit', '-m', ensureTaskMarker(opts.message, id)];
      if (!opts.sign) args.push('--no-gpg-sign');
      if (opts.verify === false) args.push('--no-verify');
      if (opts.allowEmpty) args.push('--allow-empty');

      const r = git(args);
      if (r.code !== 0) fail(t('commit.failed', { err: r.stderr || r.stdout }));

      const hash = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
      console.log(t('commit.ok', { hash, id }));
      console.log(`COMMIT_OK ${hash}`);
    });
}
