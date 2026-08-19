import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex } from '../src/platforms/index.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-codex-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('codex platform', () => {
  it('writePermissions 写 config.toml 静默权限 + hooks.json', () => {
    const res = codex.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(true);
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg).toContain('approval_policy = "never"');
    expect(cfg).toContain('sandbox_mode = "workspace-write"');
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    const hs = JSON.stringify(hooks);
    expect(hs).toContain('PreToolUse');
    expect(hs).toContain('permission-mode.mjs');
  });

  it('writePermissions 幂等:重复调用不重复加键', () => {
    codex.writePermissions(root, 'project');
    const r2 = codex.writePermissions(root, 'project');
    expect(r2.added).toEqual([]);
    expect(r2.hooksAdded).toBe(false);
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg.match(/approval_policy/g)?.length ?? 0).toBe(1);
  });

  it('writePermissions 保留既有 config.toml 键,只追加缺失键', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), 'model = "gpt-5"\n', 'utf8');
    codex.writePermissions(root, 'project');
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg).toContain('model = "gpt-5"');
    expect(cfg).toContain('approval_policy = "never"');
  });

  it('installTemplates 铺 .codex/skills + hook 脚本,无斜杠命令', () => {
    const hashRec: Record<string, string> = {};
    const items = codex.installTemplates(root, hashRec, false);
    for (const n of ['nightowl-plan', 'nightowl-run', 'nightowl-report']) {
      expect(fs.existsSync(path.join(root, '.codex', 'skills', n, 'SKILL.md'))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, '.codex', 'hooks', 'permission-mode.mjs'))).toBe(true);
    expect(items.every((i) => i.status === 'installed')).toBe(true);
    // Codex 无斜杠命令文件机制
    expect(fs.existsSync(path.join(root, '.codex', 'commands'))).toBe(false);
  });

  it('detectBypass:无 CODEX_PID → null;当前进程(无 --full-auto)→ false', () => {
    delete process.env.CODEX_PID;
    expect(codex.detectBypass()).toBeNull();
    process.env.CODEX_PID = String(process.pid);
    expect(codex.detectBypass()).toBe(false);
    delete process.env.CODEX_PID;
  });
});
