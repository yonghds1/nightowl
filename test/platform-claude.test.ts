import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claude } from '../src/platforms/index.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-claude-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('claude platform', () => {
  it('writePermissions 写 settings.json 权限 + PreToolUse hook + 脚本', () => {
    const res = claude.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toContain('Bash(nightowl *)');
    const hooks = JSON.stringify(settings.hooks.PreToolUse);
    expect(hooks).toContain('permission-mode.mjs');
    expect(hooks).toContain('CLAUDE_PROJECT_DIR');
    expect(fs.existsSync(path.join(root, '.claude', 'hooks', 'permission-mode.mjs'))).toBe(true);
  });

  it('writePermissions 幂等:重复调用不重复加规则/hooks', () => {
    claude.writePermissions(root, 'project');
    const r2 = claude.writePermissions(root, 'project');
    expect(r2.added).toEqual([]);
    expect(r2.hooksAdded).toBe(false);
  });

  it('已有其它 PreToolUse hook(如 trellis)时追加而非覆盖', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Task', hooks: [{ type: 'command', command: 'python3 .claude/hooks/inject-subagent-context.py', timeout: 30 }] },
          { matcher: 'Agent', hooks: [{ type: 'command', command: 'python3 .claude/hooks/inject-subagent-context.py', timeout: 30 }] },
        ],
      },
    };
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));

    claude.writePermissions(root, 'project');

    const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const arr = s.hooks.PreToolUse;
    expect(arr).toHaveLength(3);
    expect(arr.some((i: { matcher?: string }) => i.matcher === 'Task')).toBe(true);
    expect(arr.some((i: { matcher?: string }) => i.matcher === 'Agent')).toBe(true);
    // nightowl hook 只追加一次
    const nl = arr.filter((i: { hooks?: unknown[] }) =>
      JSON.stringify(i).includes('permission-mode.mjs')
    );
    expect(nl).toHaveLength(1);
  });

  it('已含 nightowl hook 时不重复追加(hooksAdded=false)', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Task', hooks: [{ type: 'command', command: 'python3 .claude/hooks/inject-subagent-context.py', timeout: 30 }] },
          { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/permission-mode.mjs'] }] },
        ],
      },
    };
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));

    const r = claude.writePermissions(root, 'project');
    expect(r.hooksAdded).toBe(false);

    const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse).toHaveLength(2); // 未重复追加
  });

  it('scope=local 写 settings.local.json', () => {
    claude.writePermissions(root, 'local');
    expect(fs.existsSync(path.join(root, '.claude', 'settings.local.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'settings.json'))).toBe(false);
  });

  it('installTemplates 铺 .claude/skills + hook(不再铺命令)', () => {
    const hashRec: Record<string, string> = {};
    const items = claude.installTemplates(root, hashRec, false);
    for (const n of ['nightowl-plan', 'nightowl-run', 'nightowl-report']) {
      expect(fs.existsSync(path.join(root, '.claude', 'skills', n, 'SKILL.md'))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, '.claude', 'hooks', 'permission-mode.mjs'))).toBe(true);
    // 命令铺装已移除(只留技能):斜杠命令与技能内容重复,2026-08-12 决策
    expect(fs.existsSync(path.join(root, '.claude', 'commands', 'nightowl'))).toBe(false);
    expect(items.every((i) => i.status === 'installed')).toBe(true);
  });

  it('installTemplates 幂等:重复铺为 nochange', () => {
    const hashRec: Record<string, string> = {};
    claude.installTemplates(root, hashRec, false);
    const items = claude.installTemplates(root, hashRec, false);
    expect(items.every((i) => i.status === 'nochange')).toBe(true);
  });

  describe('headlessRun(supervise 驱动)', () => {
    it('useContinue 时含 --continue,prompt 既作系统提示又作位置输入(-p 必须有输入)', () => {
      const args = claude.headlessRun!.args('PROMPT', true);
      expect(args).toContain('-p');
      expect(args).toContain('--continue');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--append-system-prompt');
      expect(args[args.length - 1]).toBe('PROMPT');
    });

    it('useContinue=false 去掉 --continue(首轮回退新开)', () => {
      const args = claude.headlessRun!.args('PROMPT', false);
      expect(args).not.toContain('--continue');
      expect(args[args.length - 1]).toBe('PROMPT');
    });
  });
});
