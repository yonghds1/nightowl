import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { createSelfcheckCommand } from '../src/commands/selfcheck.js';
import { applyPermissions } from '../src/commands/permissions.js';
import { runCommand } from './helpers.js';

let root: string;
let originalCwd: string;
let originalPid: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-selfcheck-'));
  setBaseDir(path.join(root, '.nightowl'));
  fs.mkdirSync(path.join(root, '.nightowl'), { recursive: true });
  originalCwd = process.cwd();
  originalPid = process.env.CLAUDE_PID;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalPid === undefined) delete process.env.CLAUDE_PID;
  else process.env.CLAUDE_PID = originalPid;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nightowl selfcheck', () => {
  it('hook 文件为 bypassPermissions → bypass', () => {
    fs.writeFileSync(path.join(root, '.nightowl', '.permission-mode'), 'bypassPermissions', 'utf8');
    const r = runCommand(createSelfcheckCommand(), []);
    expect(r.stdout).toContain('PERMISSION_MODE: bypass');
  });

  it('hook 文件为 default → not_bypass', () => {
    fs.writeFileSync(path.join(root, '.nightowl', '.permission-mode'), 'default', 'utf8');
    const r = runCommand(createSelfcheckCommand(), []);
    expect(r.stdout).toContain('PERMISSION_MODE: not_bypass');
  });

  it('无 hook 文件且无 CLAUDE_PID → unknown', () => {
    delete process.env.CLAUDE_PID;
    const r = runCommand(createSelfcheckCommand(), []);
    expect(r.stdout).toContain('PERMISSION_MODE: unknown');
  });

  it('无 hook 文件,CLAUDE_PID 为当前进程(非 bypass)→ not_bypass', () => {
    process.env.CLAUDE_PID = String(process.pid);
    const r = runCommand(createSelfcheckCommand(), []);
    expect(r.stdout).toContain('PERMISSION_MODE: not_bypass');
  });

  it('applyPermissions 写入 PreToolUse hook 到 settings.json', () => {
    process.chdir(root);
    const res = applyPermissions(root, 'project');
    expect(res.hooksAdded).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toBeTruthy();
    const hooks = JSON.stringify(settings.hooks.PreToolUse);
    expect(hooks).toContain('permission-mode.mjs');
    expect(hooks).toContain('CLAUDE_PROJECT_DIR');
    expect(fs.existsSync(path.join(root, '.claude', 'hooks', 'permission-mode.mjs'))).toBe(true);
  });

  it('applyPermissions 幂等:重复调用不重复加 hooks', () => {
    process.chdir(root);
    applyPermissions(root, 'project');
    const r2 = applyPermissions(root, 'project');
    expect(r2.hooksAdded).toBe(false);
  });
});
