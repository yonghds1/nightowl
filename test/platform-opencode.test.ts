import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { opencode } from '../src/platforms/index.js';
import { detectBypassFor } from '../src/platforms/opencode.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-oc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('opencode platform', () => {
  it('installTemplates 铺 .agents/skills(兼容读取),不铺 hook 脚本', () => {
    const hashRec: Record<string, string> = {};
    const items = opencode.installTemplates(root, hashRec, false);
    for (const n of ['nightowl-plan', 'nightowl-run', 'nightowl-report']) {
      expect(fs.existsSync(path.join(root, '.agents', 'skills', n, 'SKILL.md'))).toBe(true);
    }
    // OpenCode 无文件式 hook
    expect(fs.existsSync(path.join(root, '.opencode', 'hooks'))).toBe(false);
    expect(items.every((i) => i.status === 'installed')).toBe(true);
  });

  it('installTemplates 渲染无残留占位,注入 OpenCode 本地化内容', () => {
    const hashRec: Record<string, string> = {};
    opencode.installTemplates(root, hashRec, false);
    const run = fs.readFileSync(path.join(root, '.agents', 'skills', 'nightowl-run', 'SKILL.md'), 'utf8');
    expect(run).not.toMatch(/\{\{PLATFORM_[A-Z_]+\}\}/);
    expect(run).toContain('git worktree add');
    expect(run).not.toContain('subagent_type="general-purpose"');
    expect(run).not.toContain('codex exec');
  });

  it('writePermissions 新建 opencode.json 时写入 permission 规则', () => {
    const res = opencode.writePermissions(root, 'project');
    expect(res.added.length).toBeGreaterThan(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
    expect(cfg.permission.bash).toBe('allow');
    expect(cfg.permission.edit).toBe('allow');
    expect(cfg.permission.task).toBe('allow');
  });

  it('writePermissions 幂等:重复调用不再新增', () => {
    opencode.writePermissions(root, 'project');
    const r2 = opencode.writePermissions(root, 'project');
    expect(r2.added).toEqual([]);
  });

  it('writePermissions 保留既有 opencode.json 键,只补缺失 permission 项', () => {
    fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'x' }, null, 2), 'utf8');
    opencode.writePermissions(root, 'project');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
    expect(cfg.model).toBe('x');
    expect(cfg.$schema).toContain('opencode.ai');
    expect(cfg.permission.bash).toBe('allow');
  });

  it('writePermissions 遇非法 JSON 不覆盖', () => {
    fs.writeFileSync(path.join(root, 'opencode.json'), '{ 非法 // json }', 'utf8');
    const res = opencode.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(false);
    expect(res.added).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')).toContain('非法');
  });

  it('detectBypass:无 opencode.json → null;init 后 bash=allow → true', () => {
    expect(detectBypassFor(root)).toBeNull();
    opencode.writePermissions(root, 'project');
    expect(detectBypassFor(root)).toBe(true);
  });

  it('headlessRun:opencode run --auto [--continue] <prompt>', () => {
    expect(opencode.headlessRun?.cmd).toBe('opencode');
    expect(opencode.headlessRun?.args('P', true)).toEqual(['run', '--auto', '--continue', 'P']);
    expect(opencode.headlessRun?.args('P', false)).toEqual(['run', '--auto', 'P']);
  });

  it('nonInteractiveCmd 用 --auto', () => {
    expect(opencode.nonInteractiveCmd).toContain('--auto');
  });
});
