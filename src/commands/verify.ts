import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runShell, git } from '../git.js';
import { loadPool, savePool } from '../state.js';
import { isoNow } from '../util.js';
import { t } from '../i18n.js';
import { TASKS_DIR } from '../paths.js';
import { getWorktreePath } from './worktree.js';
import { assertTaskId } from '../task-id.js';

export interface VerifyOptions {
  id?: string;
  cwd?: string;
}

export function getTaskFeedbackPath(id: string): string {
  return path.join(TASKS_DIR(), id, 'feedback.json');
}

const DIAGNOSTIC_MAX_LEN = 2000;
const DIAGNOSTIC_TAIL_LINES = 30;
const DIAGNOSTIC_KEY_MAX_LINES = 15;
const KEYWORDS = ['FAIL', 'ERROR', 'Error:', 'Failed:', 'AssertionError'];

/**
 * 从 stdout/stderr 中提取可读的诊断摘要。
 * - 总长度不超过 2000 字符时整段返回,避免任何切割。
 * - 超过时保留尾部 30 行,并补充包含 FAIL/ERROR/Error:/Failed:/AssertionError 的关键行段落(最多 15 行)。
 */
export function extractDiagnostic(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  if (combined.length <= DIAGNOSTIC_MAX_LEN) {
    return combined;
  }

  const lines = combined.split('\n');
  const tailLines = lines.slice(-DIAGNOSTIC_TAIL_LINES);

  // 收集关键行及其紧邻上下文,形成可读段落。
  const keyIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && KEYWORDS.some((k) => line.includes(k))) {
      keyIndices.add(i);
      if (i > 0) keyIndices.add(i - 1);
      if (i < lines.length - 1) keyIndices.add(i + 1);
    }
  }

  const sorted = Array.from(keyIndices).sort((a, b) => a - b);
  const keyLines: string[] = [];
  for (const idx of sorted) {
    if (keyLines.length >= DIAGNOSTIC_KEY_MAX_LINES) break;
    keyLines.push(lines[idx]);
  }

  const parts: string[] = [];
  if (keyLines.length > 0) {
    parts.push('...(关键错误摘要)...', ...keyLines, '...(省略中间输出)...');
  }
  parts.push(...tailLines);
  return parts.join('\n');
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
      const cmds = task.verify ?? [];
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
          fs.writeFileSync(fbPath, JSON.stringify(feedbackData, null, 2), 'utf8');

          process.exit(1);
        }
      }

      // 验证成功, 清理旧 feedback.json
      const fbPath = getTaskFeedbackPath(taskId);
      if (fs.existsSync(fbPath)) {
        try {
          fs.unlinkSync(fbPath);
        } catch {
          // ignore cleanup error
        }
      }

      // 记录当前目标工作区的代码版本与工作区指纹
      let head: string | undefined;
      let dirty_diff_hash: string | undefined;
      const headRes = git(['rev-parse', 'HEAD'], { cwd: execCwd });
      if (headRes.code === 0 && headRes.stdout.trim()) {
        head = headRes.stdout.trim();
      }
      const statusRes = git(['status', '--porcelain'], { cwd: execCwd });
      if (statusRes.code === 0) {
        const diffStr = statusRes.stdout.trim();
        dirty_diff_hash = diffStr
          ? crypto.createHash('sha256').update(diffStr).digest('hex').slice(0, 12)
          : 'clean';
      }

      task.verify_passed = {
        at: isoNow(),
        commands: cmds,
        ...(head ? { head } : {}),
        ...(dirty_diff_hash ? { dirty_diff_hash } : {}),
      };
      savePool(pool);
      console.log('ALL_PASS');
    });
}
