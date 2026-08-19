import { vi } from 'vitest';
import type { Command } from 'commander';

export interface Captured {
  logs: string[];
  errs: string[];
  stdout: string;
  stderr: string;
  /** stdout + stderr 合并(错误信息走 console.error,断言用这个最稳) */
  output: string;
  exitCode?: number;
}

export function captureConsole(): { logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) =>
    logs.push(a.map((x) => String(x)).join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) =>
    errs.push(a.map((x) => String(x)).join(' ')),
  );
  return { logs, errs };
}

export function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((code?: unknown) => {
    const err = new Error(`process.exit(${code})`) as Error & { exitCode?: number };
    err.exitCode = typeof code === 'number' ? code : 1;
    throw err;
  });
}

/** 跑一个命令(commander 子命令直接 parse),捕获 stdout/stderr/exitCode。 */
export function runCommand(cmd: Command, args: string[]): Captured {
  const captured = captureConsole();
  const exit = mockExit();
  let exitCode: number | undefined;
  try {
    cmd.parse(args, { from: 'user' });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('process.exit(')) {
      exitCode = (e as Error & { exitCode?: number }).exitCode;
    } else {
      exit.mockRestore();
      throw e;
    }
  }
  exit.mockRestore();
  return {
    logs: captured.logs,
    errs: captured.errs,
    stdout: captured.logs.join('\n'),
    stderr: captured.errs.join('\n'),
    output: captured.logs.join('\n') + '\n' + captured.errs.join('\n'),
    exitCode,
  };
}
