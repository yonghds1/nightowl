import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runShell, git } from '../git.js';
import { loadPool, updatePool, atomicWrite } from '../state.js';
import { isoNow } from '../util.js';
import { t } from '../i18n.js';
import { TASKS_DIR } from '../paths.js';
import { getWorktreePath } from './worktree.js';
import { assertTaskId } from '../task-id.js';
import { beginVerification, finishVerification } from '../evidence.js';
import { extractDiagnostic } from '../diagnostic.js';

export { extractDiagnostic };

export interface VerifyOptions {
  id?: string;
  cwd?: string;
}

export interface VerifyReceipt {
  run_id?: string;
  at: string;
  commands: string[];
  head?: string;
  dirty_diff_hash?: string;
}

/**
 * 事务化写回验证回执:锁内重新读取 pool,只更新目标任务。
 * 新回执必须携带 run_id；无轮次的调用仅保留旧数据写入兼容，不满足正常 done 门禁。
 * verify 可能跑几分钟,期间 review/done 的改动不能被"开跑前的快照"整文件覆盖。
 */
export function recordVerifyPassed(taskId: string, receipt: VerifyReceipt): boolean {
  if (receipt.run_id) return finishVerification(taskId, receipt.run_id, receipt);
  return updatePool((pool) => {
    const target = pool.pool.find((t) => t.id === taskId);
    if (!target || target.verification_run) return false;
    target.verify_passed = receipt;
    return true;
  });
}

export function getTaskFeedbackPath(id: string): string {
  return path.join(TASKS_DIR(), id, 'feedback.json');
}

export function createVerifyCommand(): Command {
  return new Command('verify')
    .description(t('verify.desc'))
    .argument('[id]', '任务ID (兼容位置参数)')
    .option('--id <id>', '任务ID')
    .option('--cwd <dir>', '工作区执行目录(处于 worktree 隔离环境时指定)')
    .action((posId: string | undefined, options: VerifyOptions) => {
      const taskId = options.id?.trim() || posId?.trim();
      if (!taskId) {
        console.error('ERROR: 必须提供任务ID (例如: nightowl verify --id <id> 或 nightowl verify <id>)');
        process.exit(1);
      }
      try {
        assertTaskId(taskId);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
      }

      const pool = loadPool();
      if (!pool) {
        console.error(t('common.noPool'));
        process.exit(1);
      }
      const task = pool.pool.find((t) => t.id === taskId);
      if (!task) {
        console.error(t('common.taskNotFound', { id: taskId }));
        process.exit(1);
      }
      const cmds = [...(task.verify ?? [])];
      if (!cmds.length) {
        console.log('VERIFY_NONE');
        return;
      }

      // 确定执行工作区:
      // 1. 若显式指定 --cwd 则用 --cwd;
      // 2. 若存在 .nightowl/worktrees/<id> 目录则优先使用该目录;
      // 3. 否则使用当前进程工作目录。
      let execCwd = options.cwd;
      if (!execCwd) {
        const wtPath = getWorktreePath(taskId);
        if (fs.existsSync(wtPath)) {
          execCwd = wtPath;
        }
      }

      const runId = beginVerification(taskId, cmds);
      if (!runId) {
        console.error(t('verify.recordFailed', { id: taskId }));
        process.exit(1);
      }
      for (const c of cmds) {
        const r = runShell(c, { cwd: execCwd });
        if (r.code !== 0) {
          const diagnostic = extractDiagnostic(r.stdout, r.stderr);
          console.error(t('verify.failed', { id: taskId, code: r.code, cmd: c }));
          if (diagnostic) console.error(diagnostic);

          // 真实落盘 feedback.json
          const fbPath = getTaskFeedbackPath(taskId);
          const fbDir = path.dirname(fbPath);
          if (!fs.existsSync(fbDir)) {
            fs.mkdirSync(fbDir, { recursive: true });
          }
          const feedbackData = {
            taskId,
            status: 'FAILED',
            failedAt: isoNow(),
            command: c,
            exitCode: r.code,
            diagnostic,
          };
          if (!finishVerification(taskId, runId, undefined, () => {
            atomicWrite(fbPath, JSON.stringify(feedbackData, null, 2));
          })) {
            console.error(t('verify.recordFailed', { id: taskId }));
          }

          process.exit(1);
        }
      }

      // 记录当前目标工作区的代码版本与工作区指纹。
      //
      // head 是防偷改的唯一凭据:worktree merge 用它和分支 HEAD 比对,不一致就拒绝合并。
      // 取不到 head 时不能静默放过 —— 那会让 VERIFY_RECORD_STALE 这道门永远不生效,
      // 等于"验证通过"变成一张没有绑定任何代码版本的空头支票。
      let head: string | undefined;
      let dirty_diff_hash: string | undefined;
      const headRes = git(['rev-parse', 'HEAD'], { cwd: execCwd });
      if (headRes.code === 0 && headRes.stdout.trim()) {
        head = headRes.stdout.trim();
      } else {
        // 兜底:execCwd 可能已失效(worktree 被清)或不在 git 仓库内,回到项目根再试一次
        const fallback = git(['rev-parse', 'HEAD']);
        if (fallback.code === 0 && fallback.stdout.trim()) {
          head = fallback.stdout.trim();
        } else {
          // 真的拿不到版本(非 git 环境):明确告警,别让调用方以为回执已绑定代码
          console.error(
            t('verify.noHead', { id: taskId, cwd: execCwd ?? process.cwd() }),
          );
        }
      }
      const statusRes = git(['status', '--porcelain'], { cwd: execCwd });
      if (statusRes.code === 0) {
        const diffStr = statusRes.stdout.trim();
        dirty_diff_hash = diffStr
          ? crypto.createHash('sha256').update(diffStr).digest('hex').slice(0, 12)
          : 'clean';
      }

      // 不直接 savePool(陈旧快照):事务内重读,避免覆盖并发 review/status 修改
      const receipt: VerifyReceipt = {
        run_id: runId,
        at: isoNow(),
        commands: cmds,
        ...(head ? { head } : {}),
        ...(dirty_diff_hash ? { dirty_diff_hash } : {}),
      };
      if (!finishVerification(taskId, runId, receipt, () => {
        const fbPath = getTaskFeedbackPath(taskId);
        if (fs.existsSync(fbPath)) fs.unlinkSync(fbPath);
      })) {
        console.error(t('verify.recordFailed', { id: taskId }));
        process.exit(1);
      }
      console.log('ALL_PASS');
    });
}
