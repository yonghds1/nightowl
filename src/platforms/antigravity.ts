import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pkgRoot } from '../paths.js';
import { installFile } from '../commands/install.js';
import { renderTemplate } from './render.js';
import type { InstallItem, PermissionsResult, Platform } from './types.js';

const SKILLS = ['nightowl-plan', 'nightowl-run', 'nightowl-report'];

// 注:Antigravity CLI(agy)的技能/子代理/headless/权限结构按官方文档
// (antigravity.google/docs/{skills,cli/headless,cli/permissions,cli/subagents,hooks})实现,
// 本机无 agy CLI,未做真实会话验证,待有环境的用户实测后修正。
// 关键差异(与其他三家):
//   - 技能目录 .agents/skills(与 Codex/OpenCode 共享同一份铺入);自定义子代理 .agents/agents/*.md;
//   - hook stdin 无 permission_mode 字段 → 不能复用 permission-mode.mjs,selfcheck 走 ps 兜底;
//   - 权限只有全局 ~/.gemini/antigravity-cli/settings.json(无项目级),headless 未授权动作是 soft-deny
//     (静默跳过、exit 0)——所以静默 run 强烈依赖 `--dangerously-skip-permissions`(supervise 已注入),
//     否则子代理的写文件/命令会被悄悄跳过,整轮白跑。

const AGENTS = ['nightowl-implementer', 'nightowl-reviewer'];

const ANTIGRAVITY_TEMPLATE_VARS: Record<string, string> = {
  PLATFORM_ASK:
    '用纯文本逐题提问,一次一题,每题编号给 2-4 个具体选项(Antigravity 无 AskUserQuestion 类交互工具)',
  PLATFORM_RELAUNCH:
    '`agy -p --dangerously-skip-permissions <指令>`(headless 免确认;交互式无 bypass 模式,静默 run 请用 nightowl supervise 驱动)',
  PLATFORM_HEADLESS: '`agy -p --dangerously-skip-permissions --continue <续跑指令>`(首轮无历史去掉 --continue 新起)',
  PLATFORM_SUBAGENT_D:
    '先 `git worktree add <路径> -b <分支>` 建隔离区,再用 invoke_subagent 调自定义子代理\n       nightowl-implementer(.agents/agents/ 已铺;无内置 worktree 隔离,靠 worktree 目录约束)',
  PLATFORM_SUBAGENT_CALL:
    '派发方式(Antigravity):\n- 主代理用 Bash `git worktree add <worktree路径> -b <任务分支>` 建隔离区\n- 通过 invoke_subagent 调 nightowl-implementer 子代理,prompt 里显式给出 worktree 工作目录\n- 子代理在 worktree 内实现并 commit,回收合并见下"每个任务的完整闭环"',
  PLATFORM_SUBAGENT_DIR: '- 目录范围: 当前 worktree(主代理指派给子代理的隔离工作区)',
  PLATFORM_PUSH_MODE: '仅 --dangerously-skip-permissions(headless)下静默 push;soft-deny 会静默跳过推送,务必确认 bypass',
};

function installTemplates(
  projectRoot: string,
  hashRec: Record<string, string>,
  force: boolean,
): InstallItem[] {
  const results: InstallItem[] = [];
  const skillsSrc = path.join(pkgRoot(), 'skills');
  const render = renderTemplate(ANTIGRAVITY_TEMPLATE_VARS);
  // 技能:官方 workspace 位置 .agents/skills
  for (const name of SKILLS) {
    const key = path.join('.agents', 'skills', name, 'SKILL.md');
    const dst = path.join(projectRoot, key);
    results.push({
      key,
      status: installFile(path.join(skillsSrc, name, 'SKILL.md'), dst, hashRec, key, force, render),
    });
  }
  // 自定义子代理定义(.agents/agents/*.md),供 invoke_subagent 调用
  const agentsSrc = path.join(pkgRoot(), 'templates', 'agents', 'antigravity');
  for (const name of AGENTS) {
    const key = path.join('.agents', 'agents', `${name}.md`);
    const dst = path.join(projectRoot, key);
    results.push({
      key,
      status: installFile(path.join(agentsSrc, `${name}.md`), dst, hashRec, key, force, render),
    });
  }
  return results;
}

/** 全局 agy settings.json 路径;测试可用 AGY_SETTINGS_FILE 覆盖,避免污染真实 HOME。 */
function settingsFile(): string {
  return process.env.AGY_SETTINGS_FILE ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

// headless 静默所需的最小 allow 规则(command(...) / write_file(...) 语法)。
const ANTIGRAVITY_ALLOW_RULES = [
  'command(nightowl)',
  'command(git)',
  'command(node)',
  'command(npm run (test|build|lint))',
  'command(npx)',
  'read_file(*)',
  'write_file(*)',
];

/** 合并全局 permissions.allow(只增不删)。非法 JSON 不覆盖。 */
function writePermissions(projectRoot: string, scope: 'project' | 'local' = 'project'): PermissionsResult {
  // Antigravity 无项目级权限文件;scope=project 也只写全局,local 同理。projectRoot 保留以对齐接口。
  void scope;
  void projectRoot;
  const target = settingsFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let data: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      const raw = fs.readFileSync(target, 'utf8').trim();
      const obj = raw === '' ? {} : (JSON.parse(raw) as unknown);
      if (obj && typeof obj === 'object') data = obj as Record<string, unknown>;
    } catch {
      return { added: [], target, hooksAdded: false };
    }
  }
  const perms = (data.permissions as Record<string, unknown> | undefined) ?? {};
  const allow: string[] = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
  const added: string[] = [];
  for (const r of ANTIGRAVITY_ALLOW_RULES) {
    if (!allow.includes(r)) {
      allow.push(r);
      added.push(r);
    }
  }
  data.permissions = { ...perms, allow };

  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return { added, target, hooksAdded: false };
}

/**
 * 无 permission_mode hook → 兜底:
 * 1) 全局 settings 已含 nightowl allow 规则 → 视为已配静默(true);
 * 2) 否则扫 ps 找带 --dangerously-skip-permissions 的 agy 进程;
 * 3) 都判不出 → null(selfcheck unknown,引导用 --dangerously-skip-permissions)。
 */
function detectBypass(): boolean | null {
  try {
    const f = settingsFile();
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8').trim() || '{}') as Record<string, unknown>;
      const perms = data.permissions as Record<string, unknown> | undefined;
      const allow = Array.isArray(perms?.allow) ? (perms.allow as unknown[]) : [];
      if (allow.includes('command(nightowl)')) return true;
    }
  } catch {
    // 读全局失败,继续走 ps 兜底
  }
  try {
    const out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    return out
      .split('\n')
      .some((line) => /\bagy\b/.test(line) && line.includes('--dangerously-skip-permissions'));
  } catch {
    return null;
  }
}

export const antigravity: Platform = {
  id: 'antigravity',
  name: 'Antigravity',
  configDir: '.agents',
  templateVars() {
    return ANTIGRAVITY_TEMPLATE_VARS;
  },
  installTemplates,
  writePermissions,
  detectBypass,
  nonInteractiveCmd: 'agy -p --dangerously-skip-permissions',
  headlessRun: {
    cmd: 'agy',
    // agy -p <prompt>:headless 单轮;--dangerously-skip-permissions 免确认(run 静默必需);
    // --continue 续接最近会话;首轮无历史去掉 --continue 新起。
    // 注:本机无 agy CLI 未实测,待真实环境修正。
    args(prompt, useContinue) {
      const a = ['-p', prompt, '--dangerously-skip-permissions'];
      if (useContinue) a.push('--continue');
      return a;
    },
  },
};
