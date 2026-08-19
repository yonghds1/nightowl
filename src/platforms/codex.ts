import fs from 'node:fs';
import path from 'node:path';
import { pkgRoot } from '../paths.js';
import { installFile } from '../commands/install.js';
import type { InstallItem, PermissionsResult, Platform } from './types.js';

const SKILLS = ['nightowl-plan', 'nightowl-run', 'nightowl-report'];

// 注:以下 Codex 配置/hook 结构均按官方文档(learn.chatgpt.com)与 openai/codex 源码实现,
// 本机无 codex CLI,未做真实会话验证,待有 Codex 环境的用户实测后修正。

// Codex 无自定义斜杠命令文件机制(内置 /plan /approve 等,技能自动进斜杠列表),故只铺 skills + hook 脚本。

function installTemplates(
  projectRoot: string,
  hashRec: Record<string, string>,
  force: boolean,
): InstallItem[] {
  const results: InstallItem[] = [];
  const skillsSrc = path.join(pkgRoot(), 'skills');
  // 源码为 .codex/skills;官方文档另有 .agents/skills(agentskills.io 标准)之说,此处取源码位置
  for (const name of SKILLS) {
    const key = path.join('.codex', 'skills', name, 'SKILL.md');
    const dst = path.join(projectRoot, key);
    results.push({
      key,
      status: installFile(path.join(skillsSrc, name, 'SKILL.md'), dst, hashRec, key, force),
    });
  }
  // hook 脚本与 Claude 共用(Codex PreToolUse stdin 同样含 permission_mode/cwd),铺到 .codex/hooks/
  const hookKey = path.join('.codex', 'hooks', 'permission-mode.mjs');
  const hookDst = path.join(projectRoot, hookKey);
  results.push({
    key: hookKey,
    status: installFile(path.join(pkgRoot(), 'templates', 'hooks', 'permission-mode.mjs'), hookDst, hashRec, hookKey, force),
  });
  return results;
}

// 行级合并单值键:已有键不覆盖,缺失键追加,幂等。
function mergeTomlKey(existing: string, key: string, value: string): string {
  const re = new RegExp(`^\\s*${key}\\s*=`, 'm');
  if (re.test(existing)) return existing;
  const base = existing.replace(/\n?$/, '');
  return base === '' ? `${key} = ${value}\n` : `${base}\n${key} = ${value}\n`;
}

function writePermissions(projectRoot: string, scope: 'project' | 'local' = 'project'): PermissionsResult {
  const codexDir = path.join(projectRoot, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const added: string[] = [];
  const targets: string[] = [];

  // config.toml:静默权限 —— approval_policy=never + workspace-write sandbox
  const cfgTarget = path.join(codexDir, 'config.toml');
  let cfg = fs.existsSync(cfgTarget) ? fs.readFileSync(cfgTarget, 'utf8') : '';
  const cfgBefore = cfg;
  const nextCfg = mergeTomlKey(mergeTomlKey(cfg, 'approval_policy', '"never"'), 'sandbox_mode', '"workspace-write"');
  if (nextCfg !== cfgBefore) {
    cfg = nextCfg;
    added.push('approval_policy = "never"', 'sandbox_mode = "workspace-write"');
  }
  fs.writeFileSync(cfgTarget, cfg, 'utf8');
  targets.push(cfgTarget);

  // hooks.json:PreToolUse → node 跑共用脚本,只写不拦(退出 0)
  const hookTarget = path.join(codexDir, 'hooks.json');
  const want = {
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'node', args: [`${path.join('.codex', 'hooks', 'permission-mode.mjs')}`] }] },
    ],
  };
  let hooksData: Record<string, unknown> = {};
  if (fs.existsSync(hookTarget)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hookTarget, 'utf8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') hooksData = parsed;
    } catch {
      hooksData = {};
    }
  }
  const hooksAdded =
    !Array.isArray(hooksData?.PreToolUse) || JSON.stringify(hooksData.PreToolUse) !== JSON.stringify(want.PreToolUse);
  if (hooksAdded) {
    hooksData = { ...hooksData, PreToolUse: want.PreToolUse };
    added.push('hooks.PreToolUse → permission-mode.mjs');
  }
  fs.writeFileSync(hookTarget, `${JSON.stringify(hooksData, null, 2)}\n`, 'utf8');
  targets.push(hookTarget);

  return { added, target: targets.join(', '), hooksAdded };
}

/** 兜底:读 CODEX_PID(若存在)→ cmdline 含 --full-auto 视为静默模式。无 env → null。 */
function detectBypass(): boolean | null {
  const pid = process.env.CODEX_PID;
  if (!pid || !/^\d+$/.test(pid)) return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--full-auto');
  } catch {
    return null;
  }
}

export const codex: Platform = {
  id: 'codex',
  name: 'Codex',
  configDir: '.codex',
  installTemplates,
  writePermissions,
  detectBypass,
  nonInteractiveCmd: 'codex exec --full-auto --sandbox workspace-write',
};
