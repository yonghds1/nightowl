import { execFileSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 同步跑 git(参数数组,无 shell),不抛异常。code 非 0 时带回已捕获的输出。 */
export function git(args: string[], opts: { cwd?: string } = {}): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      // 全部管道接管:git 失败时 stderr 只进 err.stderr,不泄漏到终端污染协议输出
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout.trimEnd(), stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout).trimEnd() : '',
      stderr: err.stderr ? String(err.stderr).trimEnd() : '',
    };
  }
}

/** 用 shell 执行(仅 verify 的用户自定义命令),不抛异常。 */
export function runShell(
  cmd: string,
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(cmd, {
      cwd: opts.cwd,
      encoding: 'utf8',
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
      code: typeof err.status === 'number' ? err.status : 1,
    };
  }
}
