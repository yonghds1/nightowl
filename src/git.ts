import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** git 失败语义分类:调用方据此区分"可预期失败"与"环境坏了",而不是一律看 code!==0。 */
export type GitFailure = 'ok' | 'business' | 'fatal' | 'timeout' | 'spawn';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const RUN_SHELL_TIMEOUT_MS = 120_000;

const TIMEOUT_MARK = '[git timeout]';
const SHELL_TIMEOUT_MARK = '[shell timeout]';
const SPAWN_ERROR_MARK = '[spawn-error]';

/**
 * 子进程非交互环境:
 *  - GIT_TERMINAL_PROMPT=0:无人值守时绝不停在用户名/密码提示上(有 TTY 会一直等);
 *  - GIT_SSH_COMMAND:BatchMode 让首次连接/主机确认直接失败,而不是挂起;
 *  - LC_ALL=C:git 输出稳定为英文,失败归因与断言不受系统语言影响;
 *  - GIT_OPTIONAL_LOCKS=0:status/log 等只读命令不抢 index.lock,减少与 verify 并发的假失败;
 *  - GIT_PAGER/GIT_EDITOR:防分页器与编辑器把 CLI 卡住。
 * 用户已显式设置 GIT_SSH_COMMAND 时尊重用户配置。
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
}

interface ExecError {
  status?: number;
  code?: string;
  signal?: string;
  stdout?: unknown;
  stderr?: unknown;
}

function describeError(e: unknown): { err: ExecError; timeout: boolean; spawn: boolean } {
  const err = e as ExecError;
  const spawn = err.code === 'ENOENT' || err.code === 'EACCES';
  const timeout = !spawn && (err.code === 'ETIMEDOUT' || Boolean(err.signal));
  return { err, timeout, spawn };
}

/** 同步跑 git(参数数组,无 shell),不抛异常。code 非 0 时带回已捕获的输出。 */
export function git(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env: gitEnv(),
      // 全部管道接管:git 失败时 stderr 只进 err.stderr,不泄漏到终端污染协议输出
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout.trimEnd(), stderr: '' };
  } catch (e: unknown) {
    const { err, timeout, spawn } = describeError(e);
    const stdout = err.stdout ? String(err.stdout).trimEnd() : '';
    let stderr = err.stderr ? String(err.stderr).trimEnd() : '';
    if (spawn) {
      if (stderr) stderr += '\n';
      stderr += `${SPAWN_ERROR_MARK} cannot execute git (${err.code}); is git installed and on PATH?`;
    } else if (timeout) {
      if (stderr) stderr += '\n';
      stderr += `${TIMEOUT_MARK} killed by signal=${err.signal ?? 'unknown'} code=${err.code ?? 'ETIMEDOUT'}`;
    }
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout,
      stderr,
    };
  }
}

/** 用 shell 执行(仅 verify 的用户自定义命令),不抛异常。 */
export function runShell(
  cmd: string,
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(cmd, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? RUN_SHELL_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      shell: true,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: unknown) {
    const { err, timeout, spawn } = describeError(e);
    const stdout = err.stdout ? String(err.stdout) : '';
    let stderr = err.stderr ? String(err.stderr) : '';
    if (spawn) {
      if (stderr) stderr += '\n';
      stderr += `${SPAWN_ERROR_MARK} cannot execute command (${err.code})`;
    } else if (timeout) {
      if (stderr) stderr += '\n';
      stderr += `${SHELL_TIMEOUT_MARK} killed by signal=${err.signal ?? 'unknown'} code=${err.code ?? 'ETIMEDOUT'}`;
    }
    return {
      stdout,
      stderr,
      code: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

/** 探测 cwd 是否在 git 仓库内(仓库根路径)。非 git 环境(多仓父目录/普通目录)isRepo=false。
 *  每毫秒级开销,不缓存——用户可能中途 git init。 */
export function probeGit(cwd = process.cwd()): { isRepo: boolean; root: string } {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  if (r.code === 0 && r.stdout.trim()) return { isRepo: true, root: r.stdout.trim() };
  return { isRepo: false, root: '' };
}

/**
 * 把 GitResult 归类:
 *  - spawn  :git 压根没跑起来(未安装/无权限)
 *  - timeout:超时被杀
 *  - fatal  :128+ 或未知(仓库损坏、参数错误、not a git repository)
 *  - business:退出码 1,可预期的"没有结果"(如无匹配 commit、无未合并改动)
 *  - ok     :成功
 */
export function gitFailure(result: GitResult | { code: number; stderr: string }): GitFailure {
  if (result.code === 0) return 'ok';
  if (result.stderr.includes(SPAWN_ERROR_MARK)) return 'spawn';
  if (result.stderr.includes(TIMEOUT_MARK) || result.stderr.includes(SHELL_TIMEOUT_MARK)) return 'timeout';
  if (result.code === 1) return 'business';
  return 'fatal';
}

/** 当前分支名;detached HEAD 返回 null(不能拿 'main' 兜底,会写错引用)。 */
export function gitCurrentBranch(): string | null {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** 未完成的 git 操作(merge/rebase/cherry-pick/revert);没有则 null。 */
export function gitInProgressOp(): string | null {
  const markers: [string, string][] = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ];
  for (const [marker, op] of markers) {
    const p = git(['rev-parse', '--git-path', marker]);
    if (p.code !== 0 || !p.stdout.trim()) continue;
    // --git-path 返回相对 cwd 的路径(如 .git/MERGE_HEAD),resolve 后再判断存在性
    if (fs.existsSync(path.resolve(p.stdout.trim()))) return op;
  }
  return null;
}
