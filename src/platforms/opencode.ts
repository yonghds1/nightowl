import fs from 'node:fs';
import path from 'node:path';
import { pkgRoot } from '../paths.js';
import { installFile } from '../commands/install.js';
import { renderTemplate } from './render.js';
import type { InstallItem, PermissionsResult, Platform } from './types.js';

const SKILLS = ['nightowl-plan', 'nightowl-run', 'nightowl-report'];

// 注:OpenCode 配置/exec/子代理结构按官方文档(opencode.ai/docs/{skills,agents,permissions,cli})实现,
// 本机无 opencode CLI,未做真实会话验证,待有环境的用户实测后修正。
// 关键点:
//   - 技能目录:OpenCode 兼容读 .agents/skills → 与 Codex 共用一份铺入(零重复);
//   - 权限:项目 opencode.json 的 "permission" 规则;headless 用 `opencode run --auto` 自动放行非显式 deny 的操作;
//   - 无文件式 hook(只有 TS 插件),故 selfcheck 无法靠 hook 记录权限模式 → detectBypass 返回 null,走 unknown 引导;
//   - 子代理:内置 general(有写权限),无内置 worktree 隔离 → 主代理手动 git worktree 编排。

const OPENCODE_TEMPLATE_VARS: Record<string, string> = {
  PLATFORM_ASK: '用纯文本逐题提问,一次一题,每题编号给 2-4 个具体选项(OpenCode 无 AskUserQuestion 类交互工具)',
  PLATFORM_RELAUNCH:
    '`opencode run --auto`(脚本),或 TUI 命令面板 "Enable auto-approve permissions" 开启自动放行后开工',
  PLATFORM_HEADLESS: '`opencode run --auto --continue <续跑指令>`(首轮无历史会话去掉 --continue 新起)',
  PLATFORM_SUBAGENT_D:
    '通过 task 工具调内置 general 子代理(有写权限;无内置 worktree 隔离):先 `git worktree add <路径> -b <分支>`\n       建隔离区,再让子代理在该 worktree 目录下实现、commit',
  PLATFORM_SUBAGENT_CALL:
    '派发方式(OpenCode):\n- 主代理用 Bash `git worktree add <worktree路径> -b <任务分支>` 建隔离区\n- 用 task 工具调 general 子代理,prompt 里显式给出 worktree 工作目录\n- 子代理在 worktree 内实现并 commit,回收合并见下"每个任务的完整闭环"',
  PLATFORM_SUBAGENT_DIR: '- 目录范围: 当前 worktree(主代理指派给子代理的隔离工作区)',
  PLATFORM_PUSH_MODE: '仅 --auto/bypass 下静默 push',
};

function installTemplates(
  projectRoot: string,
  hashRec: Record<string, string>,
  force: boolean,
): InstallItem[] {
  const results: InstallItem[] = [];
  const skillsSrc = path.join(pkgRoot(), 'skills');
  const render = renderTemplate(OPENCODE_TEMPLATE_VARS);
  // OpenCode 兼容读取 .agents/skills(与 Codex/Antigravity 共享同一份铺入)
  for (const name of SKILLS) {
    const key = path.join('.agents', 'skills', name, 'SKILL.md');
    const dst = path.join(projectRoot, key);
    results.push({
      key,
      status: installFile(path.join(skillsSrc, name, 'SKILL.md'), dst, hashRec, key, force, render),
    });
  }
  // OpenCode 无文件式 PreToolUse hook(仅 TS 插件),不铺 permission-mode.mjs
  return results;
}

/** 把权限规则合并进项目 opencode.json 的 permission(只补缺失,不动用户既有配置)。 */
function writePermissions(projectRoot: string, scope: 'project' | 'local' = 'project'): PermissionsResult {
  // OpenCode 无 project/local 双写语义:项目 opencode.json 即项目级;local 也写同一文件。
  void scope;
  const target = path.join(projectRoot, 'opencode.json');
  let data: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      const raw = fs.readFileSync(target, 'utf8');
      const obj = raw.trim() === '' ? {} : (JSON.parse(raw) as unknown);
      if (obj && typeof obj === 'object') data = obj as Record<string, unknown>;
    } catch {
      // 非法 JSON:不盲目覆盖用户配置
      return { added: [], target, hooksAdded: false };
    }
  }

  const added: string[] = [];
  // 合法权限键见 opencode ConfigPermissionV1: read/edit/glob/grep/list/bash/task/skill 等。
  // 注意没有 "write" —— 写文件权限由 edit 覆盖(tools 映射里 write/patch 也归 edit),
  // 写 "write" 会被 schema 的 rest 索引静默吞掉成为死配置。
  const want: Record<string, unknown> = {
    // 静默 run 所需工具全部 allow;rm 保持默认(ask),由 --auto 在 headless 下放行非显式 deny 操作
    bash: 'allow',
    edit: 'allow',
    task: 'allow',
    skill: 'allow',
  };
  const existing = data.permission;
  if (existing === undefined) {
    data.permission = want;
    added.push('permission → 默认放开 bash/edit/task/skill');
  } else if (typeof existing === 'string') {
    // 已有全局字符串(如 "ask"):nightowl 不擅自改语义,保持原样,交给 --auto
    added.push('permission 已存在(全局字符串),未改动;headless 用 --auto 放行');
  } else if (existing && typeof existing === 'object') {
    const obj = existing as Record<string, unknown>;
    for (const [k, v] of Object.entries(want)) {
      if (!(k in obj)) {
        obj[k] = v;
        added.push(`permission.${k} = "${v}"`);
      }
    }
    data.permission = obj;
  }

  const tmp = `${target}.json.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return { added, target, hooksAdded: false };
}

/** 读指定目录的 opencode.json 判断是否已静默化(bash allow)。抽出便于测试。 */
export function detectBypassFor(cwd: string): boolean | null {
  try {
    const p = path.join(cwd, 'opencode.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (raw === '') return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const perm = data.permission;
    if (perm === 'allow') return true;
    if (perm && typeof perm === 'object' && (perm as Record<string, unknown>).bash === 'allow') return true;
    return null;
  } catch {
    return null;
  }
}

/**
 * 无 hook 时兜底:读项目 opencode.json,若已把 bash 权限设为 allow(全局或 tool 级),
 * 视同"静默可开工"(命令不会弹权限确认),返回 true;否则 null(unknown,引导用 --auto 启动)。
 */
function detectBypass(): boolean | null {
  return detectBypassFor(process.cwd());
}

export const opencode: Platform = {
  id: 'opencode',
  name: 'OpenCode',
  configDir: '.opencode',
  templateVars() {
    return OPENCODE_TEMPLATE_VARS;
  },
  installTemplates,
  writePermissions,
  detectBypass,
  nonInteractiveCmd: 'opencode run --auto',
  headlessRun: {
    cmd: 'opencode',
    // opencode run:非交互;--auto 自动放行未显式 deny 的权限;--continue 续接最近会话。
    // 注:本机无 opencode CLI 未实测,待真实环境修正。
    args(prompt, useContinue) {
      const a = ['run', '--auto'];
      if (useContinue) a.push('--continue');
      a.push(prompt);
      return a;
    },
  },
};
