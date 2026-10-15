import { execFileSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const RUN_SHELL_TIMEOUT_MS = 120_000;

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
      // 全部管道接管:git 失败时 stderr 只进 err.stderr,不泄漏到终端污染协议输出
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout.trimEnd(), stderr: '' };
  } catch (e: unknown) {
    const err = e as {
      status?: number;
      code?: string;
      signal?: string;
      stdout?: unknown;
      stderr?: unknown;
    };
    const isTimeout = err.code === 'ETIMEDOUT' || Boolean(err.signal);
    const stdout = err.stdout ? String(err.stdout).trimEnd() : '';
    let stderr = err.stderr ? String(err.stderr).trimEnd() : '';
    if (isTimeout) {
      if (stderr) stderr += '\n';
      stderr += `[git timeout] killed by signal=${err.signal ?? 'unknown'} code=${err.code ?? 'ETIMEDOUT'}`;
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: unknown) {
    const err = e as {
      status?: number;
      code?: string;
      signal?: string;
      stdout?: unknown;
      stderr?: unknown;
    };
    const isTimeout = err.code === 'ETIMEDOUT' || Boolean(err.signal);
    const stdout = err.stdout ? String(err.stdout) : '';
    let stderr = err.stderr ? String(err.stderr) : '';
    if (isTimeout) {
      if (stderr) stderr += '\n';
      stderr += `[shell timeout] killed by signal=${err.signal ?? 'unknown'} code=${err.code ?? 'ETIMEDOUT'}`;
    }
    return {
      stdout,
      stderr,
      code: typeof err.status === 'number' ? err.status : 1,
    };
  }
}
