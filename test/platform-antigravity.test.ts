import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravity } from '../src/platforms/index.js';

let root: string;
let settings: string;
const prevEnv = process.env.AGY_SETTINGS_FILE;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-agy-'));
  settings = path.join(root, 'agy-home', 'settings.json');
  process.env.AGY_SETTINGS_FILE = settings;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.AGY_SETTINGS_FILE;
  else process.env.AGY_SETTINGS_FILE = prevEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('antigravity platform', () => {
  it('installTemplates 铺 .agents/skills + .agents/agents 子代理定义', () => {
    const hashRec: Record<string, string> = {};
    const items = antigravity.installTemplates(root, hashRec, false);
    for (const n of ['nightowl-plan', 'nightowl-run', 'nightowl-report']) {
      expect(fs.existsSync(path.join(root, '.agents', 'skills', n, 'SKILL.md'))).toBe(true);
    }
    for (const a of ['nightowl-implementer', 'nightowl-reviewer']) {
      const f = path.join(root, '.agents', 'agents', `${a}.md`);
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.readFileSync(f, 'utf8')).toContain('subagent: true');
    }
    expect(items.every((i) => i.status === 'installed')).toBe(true);
  });

  it('installTemplates 渲染 run 无残留占位,注入 agy 本地化内容', () => {
    const hashRec: Record<string, string> = {};
    antigravity.installTemplates(root, hashRec, false);
    const run = fs.readFileSync(path.join(root, '.agents', 'skills', 'nightowl-run', 'SKILL.md'), 'utf8');
    expect(run).not.toMatch(/\{\{PLATFORM_[A-Z_]+\}\}/);
    expect(run).toContain('invoke_subagent');
    expect(run).not.toContain('subagent_type="general-purpose"');
    expect(run).not.toContain('codex exec');
    expect(run).not.toContain('opencode run');
  });

  it('writePermissions 建全局 settings.json 并合并 allow 规则', () => {
    const res = antigravity.writePermissions(root, 'project');
    expect(res.added.length).toBeGreaterThan(0);
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(data.permissions.allow).toContain('command(nightowl)');
    expect(data.permissions.allow).toContain('write_file(*)');
  });

  it('writePermissions 幂等 + 保留既有配置键', () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { allow: ['command(git)'] } }, null, 2), 'utf8');
    antigravity.writePermissions(root, 'project');
    const d1 = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(d1.theme).toBe('dark');
    expect(d1.permissions.allow).toContain('command(nightowl)');
    // 再跑一次:git 规则不重复
    const res2 = antigravity.writePermissions(root, 'project');
    expect(res2.added).not.toContain('command(git)');
    const d2 = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(d2.permissions.allow.filter((r: string) => r === 'command(git)').length).toBe(1);
  });

  it('writePermissions 遇非法 JSON 不覆盖', () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ 非法 json }', 'utf8');
    const res = antigravity.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(false);
    expect(fs.readFileSync(settings, 'utf8')).toContain('非法');
  });

  it('detectBypass:无 settings → null(unknown);init 后含 nightowl allow → true', () => {
    expect(antigravity.detectBypass()).toBeNull();
    antigravity.writePermissions(root, 'project');
    expect(antigravity.detectBypass()).toBe(true);
  });

  it('headlessRun:agy --print <prompt> --dangerously-skip-permissions [--continue] + 放大 --print-timeout', () => {
    expect(antigravity.headlessRun?.cmd).toBe('agy');
    expect(antigravity.headlessRun?.args('P', false)).toEqual(['--print', 'P', '--dangerously-skip-permissions']);
    expect(antigravity.headlessRun?.args('P', true)).toEqual(['--print', 'P', '--dangerously-skip-permissions', '--continue']);
    // 传 timeoutMs 时注入 --print-timeout:默认仅 5m,会先于 supervise 轮超时自行退出被误判快速失败
    expect(antigravity.headlessRun?.args('P', false, 30 * 60_000)).toEqual([
      '--print', 'P', '--dangerously-skip-permissions', '--print-timeout', '31m',
    ]);
  });

  it('allow 规则:交替模式带 regex: 前缀(官方 command() 默认逐字面量词前缀匹配)', () => {
    const res = antigravity.writePermissions(root, 'project');
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(data.permissions.allow).toContain('command(regex:npm run (test|build|lint))');
    expect(res.added).toContain('command(regex:npm run (test|build|lint))');
  });

  it('nonInteractiveCmd 带 --dangerously-skip-permissions', () => {
    expect(antigravity.nonInteractiveCmd).toContain('--dangerously-skip-permissions');
  });
});
