import { describe, it, expect } from 'vitest';
import { gitEnv, gitFailure } from '../src/git.js';

describe('git 子进程环境加固', () => {
  it('强制非交互:禁止终端提示、分页器与编辑器', () => {
    const env = gitEnv({ PATH: '/usr/bin' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.GIT_EDITOR).toBe('true');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('尊重用户已设置的 GIT_SSH_COMMAND', () => {
    const env = gitEnv({ GIT_SSH_COMMAND: 'ssh -i /key -p 2222' });
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /key -p 2222');
  });

  it('不修改传入的 process.env', () => {
    const src = { PATH: '/usr/bin' };
    gitEnv(src);
    expect(src).toEqual({ PATH: '/usr/bin' });
  });
});

describe('git 失败语义归类', () => {
  it('成功 / 业务失败 / fatal / 超时 / 未安装', () => {
    expect(gitFailure({ code: 0, stderr: '' })).toBe('ok');
    expect(gitFailure({ code: 1, stderr: 'fatal: bad revision' })).toBe('business');
    expect(gitFailure({ code: 128, stderr: 'fatal: not a git repository' })).toBe('fatal');
    expect(gitFailure({ code: 1, stderr: '[git timeout] killed by signal=SIGTERM' })).toBe('timeout');
    expect(gitFailure({ code: 1, stderr: '[spawn-error] cannot execute git (ENOENT)' })).toBe('spawn');
  });
});
