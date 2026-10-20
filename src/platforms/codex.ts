import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pkgRoot } from '../paths.js';
import { installFile } from '../commands/install.js';
import { renderTemplate } from './render.js';
import type { InstallItem, PermissionsResult, Platform } from './types.js';

import { PROJECT_SKILLS } from '../skills.js';

// 注:以下 Codex 配置/hook/exec 结构按官方文档(learn.chatgpt.com / developers.openai.com/codex)实现,
// 本机无 codex CLI,未做真实会话验证,待有 Codex 环境的用户实测后修正。
// 关键更正(vs 早期实现):
//   - 技能目录是 .agents/skills(官方扫描 CWD→repo root + ~/.agents/skills),不是 .codex/skills;
//   - --full-auto 已废弃,headless 用 `codex exec --sandbox workspace-write`,静默配 config `approval_policy = "never"`;
//   - workspace-write 沙箱默认禁网 → 合并/推送需 network_access = true。
// hook 脚本目录仍是 .codex/hooks(官方支持 <repo>/.codex/hooks.json);Codex PreToolUse stdin 含
// permission_mode(枚举与 Claude 一致),故与 Claude 共用 permission-mode.mjs。

// Codex 平台占位符变量:与 Claude 同一技能源,渲染出 Codex 本地化的执行细节。
const CODEX_TEMPLATE_VARS: Record<string, string> = {
  PLATFORM_ASK:
    '用纯文本逐题提问,一次一题,每题编号给 2-4 个具体选项(Codex 无 AskUserQuestion 类交互工具)',
  PLATFORM_RELAUNCH:
    '`codex exec --sandbox workspace-write --skip-git-repo-check`(静默需在 .codex/config.toml 配 `approval_policy = "never"`;非 git 目录必须带 --skip-git-repo-check;完全免沙箱用 `--dangerously-bypass-approvals-and-sandbox`)',
  PLATFORM_HEADLESS: '`codex exec resume --last <续跑指令>`(首轮无历史会话去掉 resume 新起)',
  PLATFORM_SUBAGENT_D:
    'Codex 子代理(无内置 worktree 隔离):先 `git worktree add <路径> -b <分支>` 建隔离工作区,\n       再指示 Codex 派 worker 子代理在该 worktree 目录下实现、commit',
  PLATFORM_SUBAGENT_CALL:
    '派发方式(Codex):\n- 主代理用 Bash `git worktree add <worktree路径> -b <任务分支>` 建隔离区\n- 以自然语言请求 Codex 派 worker 子代理,在 prompt 里显式给出 worktree 工作目录\n- 子代理在 worktree 内实现并 commit,回收合并见下"每个任务的完整闭环"',
  PLATFORM_SUBAGENT_DIR: '- 目录范围: 当前 worktree(由主代理指派给子代理的隔离工作区)',
  PLATFORM_PUSH_MODE: '仅 bypass(workspace-write + network_access)下静默 push',
};

function installTemplates(
  projectRoot: string,
  hashRec: Record<string, string>,
  force: boolean,
): InstallItem[] {
  const results: InstallItem[] = [];
  const skillsSrc = path.join(pkgRoot(), 'skills');
  const render = renderTemplate(CODEX_TEMPLATE_VARS);
  // 官方技能扫描位:.agents/skills(仓库根及各级父目录,CWD 向上);非 .codex/skills
  for (const name of PROJECT_SKILLS) {
    const key = path.join('.agents', 'skills', name, 'SKILL.md');
    const dst = path.join(projectRoot, key);
    results.push({
      key,
      status: installFile(path.join(skillsSrc, name, 'SKILL.md'), dst, hashRec, key, force, render),
    });
  }
  // hook 脚本:Codex 支持 <repo>/.codex/hooks.json + .codex/hooks/ 脚本;stdin 含 permission_mode,与 Claude 共用脚本
  const hookKey = path.join('.codex', 'hooks', 'permission-mode.mjs');
  const hookDst = path.join(projectRoot, hookKey);
  results.push({
    key: hookKey,
    status: installFile(path.join(pkgRoot(), 'templates', 'hooks', 'permission-mode.mjs'), hookDst, hashRec, hookKey, force),
  });
  return results;
}

// 顶层区 = 文件开头到第一个 [section] 头之前(无 section 则整文件为顶层区)。
// 顶层键必须落在这一段,否则会被后续 [table] 吞成该表的键,Codex 读不到顶层值。
function splitTopLevel(existing: string): { head: string; rest: string } {
  const m = /^\s*\[[^\]]+\]\s*(#.*)?$/m.exec(existing);
  if (!m) return { head: existing, rest: '' };
  return { head: existing.slice(0, m.index), rest: existing.slice(m.index) };
}

/** 从文本尾部摘出连续的空行/注释行(TOML 里它们按惯例属于紧随其后的 section)。 */
function detachTrailingComments(text: string): { kept: string; anchor: string } {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && /^\s*(#.*)?$/.test(lines[end - 1])) end -= 1;
  return { kept: lines.slice(0, end).join('\n'), anchor: lines.slice(end).join('\n') };
}

// 合并顶层单值键:仅在顶层区检测/插入(避免埋进 [table] 段),已有键不覆盖,幂等。
// 插入点回退到紧邻首个 section 的注释块之前,不把注释和它的段拆散。
function mergeTomlKey(existing: string, key: string, value: string): string {
  const { head, rest } = splitTopLevel(existing);
  if (new RegExp(`^\\s*${key}\\s*=`, 'm').test(head)) return existing;
  const { kept, anchor } = detachTrailingComments(head);
  const headOut = kept === '' ? `${key} = ${value}\n` : `${kept}\n${key} = ${value}\n`;
  if (rest === '') return `${headOut}${anchor}`;
  // anchor(空行+注释块)自带换行,直接拼接可保持"注释紧贴其 section"
  return anchor === '' ? `${headOut}\n${rest}` : `${headOut}${anchor}${rest}`;
}

// 合并 [table] 段下的键:无段则整段追加;有段但缺键则在段末追加(回退过段尾注释块);有键不动。
function mergeTomlTableKey(existing: string, table: string, key: string, value: string): string {
  const headerRe = new RegExp(`^\\s*\\[${table}\\]\\s*(#.*)?$`, 'm');
  const m = headerRe.exec(existing);
  if (!m) {
    const base = existing.replace(/\n?$/, '');
    const sep = base === '' ? '' : '\n';
    return `${base}${sep}\n[${table}]\n${key} = ${value}\n`;
  }
  // 段体 = 从 header 到下一个 [section](含带尾注的头)或文件末尾
  const after = existing.slice(m.index + m[0].length);
  const nextSection = after.search(/^\s*\[[^\]]+\]\s*(#.*)?$/m);
  const rawEnd = nextSection === -1 ? existing.length : m.index + m[0].length + nextSection;
  const body = existing.slice(m.index + m[0].length, rawEnd);
  if (new RegExp(`^\\s*${key}\\s*=`, 'm').test(body)) return existing;
  // 插入点回退过段尾注释块(它们通常描述紧随的下一个 section),且不得越过 header
  const { kept } = detachTrailingComments(body);
  const bodyEnd = Math.min(m.index + m[0].length + kept.length, rawEnd);
  const gap = existing.slice(bodyEnd - 1, bodyEnd) === '\n' ? '' : '\n';
  return existing.slice(0, bodyEnd) + gap + `${key} = ${value}\n` + existing.slice(bodyEnd);
}

function writePermissions(projectRoot: string, scope: 'project' | 'local' = 'project'): PermissionsResult {
  // Codex 无 project/local 之分:项目层 .codex 只在受信时加载;scope 参数保留以对齐接口。
  void scope;
  const codexDir = path.join(projectRoot, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const added: string[] = [];
  const targets: string[] = [];

  // config.toml:静默权限 —— approval_policy=never + workspace-write 沙箱 + 放开网络(合并/推送要联网)
  const cfgTarget = path.join(codexDir, 'config.toml');
  let cfg = fs.existsSync(cfgTarget) ? fs.readFileSync(cfgTarget, 'utf8') : '';
  const wantCfg: Array<[string, string, string | null, string]> = [
    ['approval_policy', '"never"', null, 'approval_policy = "never"'],
    ['sandbox_mode', '"workspace-write"', null, 'sandbox_mode = "workspace-write"'],
    ['network_access', 'true', 'sandbox_workspace_write', '[sandbox_workspace_write] network_access = true'],
  ];
  for (const [key, value, table, label] of wantCfg) {
    const before = cfg;
    cfg = table === null ? mergeTomlKey(cfg, key, value) : mergeTomlTableKey(cfg, table, key, value);
    if (cfg !== before) added.push(label);
  }
  // 先校验 hooks.json 再落盘:任一文件不合法则整体不写,避免半改状态。
  const hookTarget = path.join(codexDir, 'hooks.json');
  let hooksData: Record<string, unknown> = {};
  if (fs.existsSync(hookTarget)) {
    try {
      const parsed = fs.readFileSync(hookTarget, 'utf8');
      const obj = parsed.trim() === '' ? {} : (JSON.parse(parsed) as Record<string, unknown>);
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        return { added: [], target: targets.join(', '), hooksAdded: false };
      }
      hooksData = obj;
    } catch {
      // 解析失败(非合法 JSON,含注释):不盲目覆盖用户配置,config.toml 也回退不写
      return { added: [], target: targets.join(', '), hooksAdded: false };
    }
  }
  fs.writeFileSync(cfgTarget, cfg, 'utf8');
  targets.push(cfgTarget);

  // hooks.json 结构(codex 0.163.0 实测 schema,与 Claude 的 settings.json 完全不同):
  //   顶层 { "hooks": { "<事件名>": [MatcherGroup...] } } —— 顶层直接放 PreToolUse 会报
  //   unknown field `PreToolUse`, expected `description` or `hooks`。
  //   MatcherGroup { matcher?, hooks: [HookEntry] }。
  //   HookEntry { type: "command", command: "<一条 shell 命令字符串>" } —— 实测 args 字段
  //   (Claude 风格)被静默忽略,必须把参数拼进 command 字符串。
  // 用户已有同事件 group 时追加我们的 hook entry,不整体替换(否则会静默摧毁其自配钩子)。
  const hookPath = path.join('.codex', 'hooks', 'permission-mode.mjs');
  const oursCommand = `node ${hookPath}`;
  const oursEntry = { type: 'command', command: oursCommand };

  // 兼容迁移:Claude 风格的 { "<事件>": [ {hooks:[...]} ] }(事件在顶层)整体搬进 hooks 表。
  // 事件键之外的用户键(如 description)原样保留。
  const events = hooksData.hooks && typeof hooksData.hooks === 'object' && !Array.isArray(hooksData.hooks)
    ? (hooksData.hooks as Record<string, unknown>)
    : null;
  const legacyKeys = Object.keys(hooksData).filter(
    (k) => k !== 'hooks' && k !== 'description' && Array.isArray(hooksData[k]),
  );
  let eventTable: Record<string, unknown>;
  if (events) {
    eventTable = events;
  } else {
    eventTable = {};
    for (const k of legacyKeys) {
      eventTable[k] = hooksData[k];
      delete hooksData[k];
    }
  }

  const groups = Array.isArray(eventTable.PreToolUse) ? (eventTable.PreToolUse as unknown[]) : [];
  const alreadyOurs = groups.some((g) => groupHasOurCommand(g, hookPath));
  let hooksAdded = false;
  if (!alreadyOurs) {
    eventTable.PreToolUse = [...groups, { hooks: [oursEntry] }];
    added.push('hooks.PreToolUse → permission-mode.mjs');
    hooksAdded = true;
  }
  hooksData.hooks = eventTable;
  fs.writeFileSync(hookTarget, `${JSON.stringify(hooksData, null, 2)}\n`, 'utf8');
  targets.push(hookTarget);

  return { added, target: targets.join(', '), hooksAdded };
}

/** group(任意层级的 matcher 结构)里是否已含指向目标脚本的 command(按 command 字符串后缀匹配)。 */
function groupHasOurCommand(group: unknown, hookPath: string): boolean {
  if (!group || typeof group !== 'object') return false;
  const entries = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(entries)) return false;
  const want = path.normalize(hookPath).replaceAll('\\', '/');
  return entries.some((e) => {
    const command = (e as { command?: unknown } | null)?.command;
    return (
      typeof command === 'string' &&
      path.normalize(command).replaceAll('\\', '/').endsWith(want)
    );
  });
}

/** 兜底:读 CODEX_PID(若存在)→ cmdline 含免审批特征视为静默模式。无 env → null。 */
function detectBypass(): boolean | null {
  const pid = process.env.CODEX_PID;
  if (!pid || !/^\d+$/.test(pid)) return null;
  const BYPASS_FLAGS = ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto'];
  const hit = (cmdline: string): boolean => BYPASS_FLAGS.some((f) => cmdline.includes(f));
  try {
    return hit(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    // 非 Linux / 无 /proc:走 ps
  }
  try {
    return hit(execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

export const codex: Platform = {
  id: 'codex',
  name: 'Codex',
  configDir: '.codex',
  templateVars() {
    return CODEX_TEMPLATE_VARS;
  },
  installTemplates,
  writePermissions,
  detectBypass,
  // --full-auto 已废弃;静默靠 config approval_policy=never(workspace-write)或显式 bypass 标志。
  // --dangerously-bypass-hook-trust:无人值守轮里 hook 无法走交互信任流程,缺它 hook 静默不执行
  // (实测 codex 0.163.0);只豁免 hook 信任,不放大沙箱权限。
  nonInteractiveCmd:
    'codex exec --sandbox workspace-write --skip-git-repo-check --dangerously-bypass-hook-trust',
  headlessRun: {
    cmd: 'codex',
    // --skip-git-repo-check:任务根可能不是 git 仓库(多仓父目录),没它 codex 直接拒启动
    // (实测:"Not inside a trusted directory and --skip-git-repo-check was not specified")。
    // 续接用 `codex exec resume --last <prompt>`;首轮无历史会话去掉 resume 新起。
    // sandbox 权限来自 init 写入的 .codex/config.toml(approval_policy=never + workspace-write + 放网)。
    args(prompt, useContinue) {
      if (useContinue) {
        return ['exec', 'resume', '--last', prompt, '--skip-git-repo-check', '--dangerously-bypass-hook-trust'];
      }
      return [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--dangerously-bypass-hook-trust',
        prompt,
      ];
    },
  },
};
