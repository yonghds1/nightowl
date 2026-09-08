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
  it('writePermissions 写 config.toml 静默权限(含 sandbox 网络放开)+ hooks.json', () => {
    const res = codex.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(true);
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg).toContain('approval_policy = "never"');
    expect(cfg).toContain('sandbox_mode = "workspace-write"');
    expect(cfg).toContain('[sandbox_workspace_write]');
    expect(cfg).toContain('network_access = true');
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    expect(JSON.stringify(hooks)).toContain('PreToolUse');
    expect(JSON.stringify(hooks)).toContain('permission-mode.mjs');
  });

  it('writePermissions 幂等:重复调用不重复加键', () => {
    codex.writePermissions(root, 'project');
    const r2 = codex.writePermissions(root, 'project');
    expect(r2.added).toEqual([]);
    expect(r2.hooksAdded).toBe(false);
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg.match(/approval_policy/g)?.length ?? 0).toBe(1);
    expect(cfg.match(/\[sandbox_workspace_write\]/g)?.length ?? 0).toBe(1);
    expect(cfg.match(/network_access/g)?.length ?? 0).toBe(1);
  });

  it('writePermissions 保留既有 config.toml 键与段,只追加缺失项', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), 'model = "gpt-5"\n', 'utf8');
    codex.writePermissions(root, 'project');
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg).toContain('model = "gpt-5"');
    expect(cfg).toContain('approval_policy = "never"');
    // 再写一次已有 table 段时不应重复追加
    codex.writePermissions(root, 'project');
    const cfg2 = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg2.match(/\[sandbox_workspace_write\]/g)?.length).toBe(1);
  });

  it('writePermissions 遇非法 JSON 的 hooks.json 不盲目覆盖,config.toml 也不写(非半改状态)', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), '{ 这不是合法 JSON // 带注释 }', 'utf8');
    const res = codex.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(false);
    // 原文件保持不变
    expect(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8')).toContain('不是合法 JSON');
    // 原子性:hooks 被拒时 config.toml 不应已被写入
    expect(fs.existsSync(path.join(root, '.codex', 'config.toml'))).toBe(false);
  });

  it('writePermissions 不把顶层键插进"注释与其 section"之间;段尾注释块保持粘连', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n# 项目信任记录\n[projects.foo]\ntrust = "enabled"\n',
      'utf8',
    );
    codex.writePermissions(root, 'project');
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg).toMatch(/# 项目信任记录\n\[projects\.foo\]/);
    expect(cfg).toContain('[sandbox_workspace_write]\nnetwork_access = true');
  });

  it('writePermissions 顶层键不被埋进既有 [table] 段(P1 回归)', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.ctx]\ncmd = "npx ctx"\n',
      'utf8',
    );
    codex.writePermissions(root, 'project');
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    const firstSection = cfg.search(/^\[[^\]]+\]\s*$/m);
    const top = cfg.slice(0, firstSection);
    expect(top).toContain('approval_policy = "never"');
    expect(top).toContain('sandbox_mode = "workspace-write"');
    // 既有段之后(含新插入的 [sandbox_workspace_write] 之前)不得吞掉顶层键
    expect(cfg.slice(firstSection)).not.toMatch(/^\s*approval_policy\s*=/m);
    expect(cfg).toContain('[mcp_servers.ctx]');
  });

  it('writePermissions 段内已有同名键不误判为顶层已配置,重跑幂等', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[projects.foo]\napproval_policy = "on-request"\n', 'utf8');
    codex.writePermissions(root, 'project');
    const cfg = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    const firstSection = cfg.search(/^\[[^\]]+\]\s*$/m);
    expect(cfg.slice(0, firstSection)).toContain('approval_policy = "never"');
    // 幂等:再跑一次顶层不重复
    codex.writePermissions(root, 'project');
    const cfg2 = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    expect(cfg2).toBe(cfg);
  });

  it('writePermissions 保留用户既有 PreToolUse hooks,仅追加我们的 matcher', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    const userHooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['my-audit.mjs'] }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }],
    };
    fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify(userHooks, null, 2), 'utf8');
    const res = codex.writePermissions(root, 'project');
    expect(res.hooksAdded).toBe(true);
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks.PreToolUse[0])).toContain('my-audit.mjs');
    expect(JSON.stringify(hooks.PreToolUse[1])).toContain('permission-mode.mjs');
    expect(hooks.PostToolUse).toHaveLength(1);
    // 幂等:再跑一次不重复追加
    const res2 = codex.writePermissions(root, 'project');
    expect(res2.hooksAdded).toBe(false);
    const hooks2 = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks2.PreToolUse).toHaveLength(2);
  });

  it('installTemplates 铺 .agents/skills(官方扫描位)+ .codex/hook 脚本', () => {
    const hashRec: Record<string, string> = {};
    const items = codex.installTemplates(root, hashRec, false);
    for (const n of ['nightowl-plan', 'nightowl-run', 'nightowl-report']) {
      expect(fs.existsSync(path.join(root, '.agents', 'skills', n, 'SKILL.md'))).toBe(true);
    }
    // 兼容旧路径不再使用
    expect(fs.existsSync(path.join(root, '.codex', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codex', 'hooks', 'permission-mode.mjs'))).toBe(true);
    expect(items.every((i) => i.status === 'installed')).toBe(true);
    expect(fs.existsSync(path.join(root, '.codex', 'commands'))).toBe(false);
  });

  it('installTemplates 渲染掉所有 {{PLATFORM_*}} 占位,并注入 Codex 本地化内容', () => {
    const hashRec: Record<string, string> = {};
    codex.installTemplates(root, hashRec, false);
    const run = fs.readFileSync(path.join(root, '.agents', 'skills', 'nightowl-run', 'SKILL.md'), 'utf8');
    expect(run).not.toMatch(/\{\{PLATFORM_[A-Z_]+\}\}/);
    // Codex 版子代理派发应出现 worktree add / worker 子代理,而非 Claude 的 Agent 工具参数
    expect(run).toContain('git worktree add');
    expect(run).not.toContain('subagent_type="general-purpose"');
    const plan = fs.readFileSync(path.join(root, '.agents', 'skills', 'nightowl-plan', 'SKILL.md'), 'utf8');
    expect(plan).not.toMatch(/\{\{PLATFORM_[A-Z_]+\}\}/);
    expect(plan).toContain('AskUserQuestion');
    // AskUserQuestion 只应出现在"无"的否定语境里
    const askLine = plan.split('\n').find((l) => l.includes('AskUserQuestion')) ?? '';
    expect(askLine).toContain('无');
  });

  it('detectBypass:无 CODEX_PID → null;当前进程(无 bypass 标志)→ false', () => {
    delete process.env.CODEX_PID;
    expect(codex.detectBypass()).toBeNull();
    process.env.CODEX_PID = String(process.pid);
    expect(codex.detectBypass()).toBe(false);
    delete process.env.CODEX_PID;
  });

  it('headlessRun:续接用 exec resume --last,首轮用 exec --sandbox workspace-write', () => {
    expect(codex.headlessRun?.cmd).toBe('codex');
    expect(codex.headlessRun?.args('P', true)).toEqual(['exec', 'resume', '--last', 'P']);
    expect(codex.headlessRun?.args('P', false)).toEqual(['exec', '--sandbox', 'workspace-write', 'P']);
  });

  it('nonInteractiveCmd 不再使用废弃的 --full-auto', () => {
    expect(codex.nonInteractiveCmd).not.toContain('--full-auto');
    expect(codex.nonInteractiveCmd).toContain('--sandbox');
  });
});
