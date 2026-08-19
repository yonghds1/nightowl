import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pkgRoot } from '../paths.js';
import { installFile } from '../commands/install.js';
import type { InstallItem, PermissionsResult, Platform } from './types.js';

const SKILLS = ['nightowl-plan', 'nightowl-run', 'nightowl-report'];

// Claude Code 权限规则:写入 .claude/settings.json 的 permissions.allow,
// 让 plan/run 阶段的 nightowl 与 git 命令不再弹权限确认。
export const PERMISSION_RULES = [
  // nightowl 命令本身
  'Bash(nightowl *)',
  // git 状态与提交
  'Bash(git status)',
  'Bash(git log *)',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git cherry *)',
  'Bash(git rev-parse *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git config *)',
  // git 分支 / worktree 生命周期
  'Bash(git branch *)',
  'Bash(git checkout *)',
  'Bash(git merge *)',
  'Bash(git cherry-pick *)',
  'Bash(git worktree *)',
  // git 远端
  'Bash(git remote *)',
  'Bash(git fetch *)',
  'Bash(git pull *)',
  'Bash(git push *)',
  // 测试 / 构建
  'Bash(npm test *)',
  'Bash(npm run *)',
  'Bash(npx vitest *)',
  'Bash(npx tsc *)',
  'Bash(npx tsx *)',
  'Bash(python3 -m unittest *)',
  'Bash(python3 -m py_compile *)',
  // 文件与运行(run 子代理在 worktree 里搬移文件、清理、跑脚本)
  'Bash(mv *)',
  'Bash(rm *)',
  'Bash(mkdir *)',
  'Bash(cp *)',
  'Bash(node *)',
  'Bash(npx *)',
  // 文档分析阶段的只读命令
  'Bash(ls *)',
  'Bash(find *)',
  'Bash(grep *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
];

// PreToolUse hook:每次工具调用把当前权限模式写入 .nightowl/.permission-mode,供 selfcheck 读取。
// exec form(node + args)引用铺好的脚本,不依赖 shell/exec bit;退出 0 不拦截工具调用。
export const PERMISSION_MODE_HOOKS = {
  PreToolUse: [
    {
      hooks: [
        { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/permission-mode.mjs'] },
      ],
    },
  ],
};

/** 判断 PreToolUse 数组是否已含 nightowl 的权限模式 hook(按脚本路径特征匹配)。 */
function hasPermissionModeHook(hooksArr: unknown): boolean {
  if (!Array.isArray(hooksArr)) return false;
  return hooksArr.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const hs = (item as { hooks?: unknown }).hooks;
    if (!Array.isArray(hs)) return false;
    return hs.some((h) => {
      if (!h || typeof h !== 'object') return false;
      const rec = h as { command?: unknown; args?: unknown };
      return (
        rec.command === 'node' &&
        Array.isArray(rec.args) &&
        rec.args.some((a) => typeof a === 'string' && a.includes('permission-mode.mjs'))
      );
    });
  });
}

function installTemplates(
  projectRoot: string,
  hashRec: Record<string, string>,
  force: boolean,
): InstallItem[] {
  const results: InstallItem[] = [];
  const skillsSrc = path.join(pkgRoot(), 'skills');
  for (const name of SKILLS) {
    const key = path.join('.claude', 'skills', name, 'SKILL.md');
    const dst = path.join(projectRoot, key);
    results.push({
      key,
      status: installFile(path.join(skillsSrc, name, 'SKILL.md'), dst, hashRec, key, force),
    });
  }
  // PreToolUse hook 脚本(记录权限模式,供 selfcheck 读取);放 .claude/ 下随项目入库
  const hookKey = path.join('.claude', 'hooks', 'permission-mode.mjs');
  const hookDst = path.join(projectRoot, hookKey);
  results.push({
    key: hookKey,
    status: installFile(path.join(pkgRoot(), 'templates', 'hooks', 'permission-mode.mjs'), hookDst, hashRec, hookKey, force),
  });
  return results;
}

/** 把权限规则合并进 .claude/settings.json(只增不删)。scope=local 写 settings.local.json。 */
export function applyPermissions(projectRoot: string, scope: 'project' | 'local' = 'project'): PermissionsResult {
  const claudeDir = path.join(projectRoot, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const fname = scope === 'local' ? 'settings.local.json' : 'settings.json';
  const target = path.join(claudeDir, fname);

  let data: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch {
      data = {};
    }
  }

  const permsObj = data.permissions as Record<string, unknown> | undefined;
  const allow: string[] = Array.isArray(permsObj?.allow) ? (permsObj.allow as string[]) : [];
  const added: string[] = [];
  for (const r of PERMISSION_RULES) {
    if (!allow.includes(r)) {
      allow.push(r);
      added.push(r);
    }
  }

  const perms = (data.permissions as Record<string, unknown> | undefined) ?? {};
  data.permissions = { ...perms, allow };

  // 配置与脚本必须成对:setup-permissions 可能未跑 init,这里兜底确保脚本文件存在
  // (存在则不动,模板升级交给 init --force 的 hash 逻辑)
  const scriptDst = path.join(claudeDir, 'hooks', 'permission-mode.mjs');
  const scriptSrc = path.join(pkgRoot(), 'templates', 'hooks', 'permission-mode.mjs');
  if (fs.existsSync(scriptSrc) && !fs.existsSync(scriptDst)) {
    fs.mkdirSync(path.dirname(scriptDst), { recursive: true });
    fs.copyFileSync(scriptSrc, scriptDst);
  }

  const existingHooks = (data.hooks as Record<string, unknown> | undefined) ?? {};
  const existingPreToolUse = existingHooks.PreToolUse;
  // 追加而非整体替换:settings.json 可能含其它工具的 PreToolUse hook(如 trellis),
  // 整体替换会踩掉它们。已含本 hook 则不动,未含则追加到末尾。
  const hooksAdded = !hasPermissionModeHook(existingPreToolUse);
  if (hooksAdded) {
    const existingArr = Array.isArray(existingPreToolUse) ? existingPreToolUse : [];
    data.hooks = {
      ...existingHooks,
      PreToolUse: [...existingArr, ...PERMISSION_MODE_HOOKS.PreToolUse],
    };
  }

  const tmp = `${target}.json.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);

  return { added, target, hooksAdded };
}

/** 兜底:读 CLAUDE_PID 进程 cmdline 是否 --dangerously-skip-permissions。true=bypass,false=非, null=无法检测。 */
function detectBypass(): boolean | null {
  const pid = process.env.CLAUDE_PID;
  if (!pid || !/^\d+$/.test(pid)) return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--dangerously-skip-permissions');
  } catch {
    // Linux 无 /proc 时走 ps
  }
  try {
    const out = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
    return out.includes('--dangerously-skip-permissions');
  } catch {
    return null;
  }
}

export const claude: Platform = {
  id: 'claude',
  name: 'Claude Code',
  configDir: '.claude',
  installTemplates,
  writePermissions: applyPermissions,
  detectBypass,
  nonInteractiveCmd: 'claude --dangerously-skip-permissions',
  headlessRun: {
    cmd: 'claude',
    // -p headless 输出完自动退出;--continue 延续最近主会话;--append-system-prompt 注入续跑指令。
    // -p 必须有实际输入:prompt 同时作为系统提示注入 + 位置参数用户消息(supervise 每轮都会注入)。
    // 实测无历史会话时 claude 对 --continue 宽容(静默新开,exit 0);若 continue 真报错,
    // supervise 检测到快速失败会回退去掉 --continue 新开会话。
    args(prompt, useContinue) {
      const a = ['-p', '--dangerously-skip-permissions', '--append-system-prompt', prompt];
      if (useContinue) a.splice(1, 0, '--continue');
      a.push(prompt);
      return a;
    },
  },
};
