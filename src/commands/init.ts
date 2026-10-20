import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE, POOL_FILE, PLATFORM_FILE, ensureBaseDir, getBaseDir, getPkgVersion } from '../paths.js';
import { savePool, saveState, log, type AppState, type Pool } from '../state.js';
import { printPermissionsResult } from './permissions.js';
import { t } from '../i18n.js';
import { resolvePlatform, platformFromFlags } from '../platforms/index.js';
import type { Platform } from '../platforms/types.js';

// init's skill registry is shared with every platform installer.
export { PROJECT_SKILLS } from '../skills.js';

export const DEFAULT_RETRY_BUDGET = 2;

// 保持对外导出,兼容既有测试/引用;实现已移到独立的 install.ts(避免 platform 与 init 循环依赖)
import { loadTemplateHashes, saveTemplateHashes } from './install.js';
export { installFile, loadTemplateHashes, saveTemplateHashes } from './install.js';

/** 按平台铺技能/命令/hook 到目标项目,hash 记录到 .template-hashes.json(原子写,含技能版本戳)。 */
export function installProjectTemplates(platform: Platform, force: boolean): void {
  const projectRoot = path.dirname(getBaseDir());
  const rec = loadTemplateHashes() ?? { hashes: {} };
  const hashRec = rec.hashes;
  const results = platform.installTemplates(projectRoot, hashRec, force);
  // 原子写 + 每次都刷新技能版本戳(含全 nochange / 损坏恢复场景,让 status 自检有据)
  saveTemplateHashes({ hashes: hashRec, skillsVersion: getPkgVersion() });

  const installed = results.filter((r) => r.status === 'installed');
  const updated = results.filter((r) => r.status === 'updated');
  const forced = results.filter((r) => r.status === 'forced');
  const skipped = results.filter((r) => r.status === 'skipped');
  const missing = results.filter((r) => r.status === 'missing');
  if (installed.length || updated.length || forced.length) {
    console.log('');
    for (const r of [...installed, ...updated, ...forced]) {
      const msg =
        r.status === 'installed'
          ? t('init.tplInstalled', { dst: r.key })
          : r.status === 'forced'
            ? t('init.tplForced', { dst: r.key })
            : t('init.tplUpdated', { dst: r.key });
      console.log(msg);
    }
    console.log(t('init.commandsReady'));
  }
  if (skipped.length) {
    for (const r of skipped) console.log(t('init.tplSkipped', { dst: r.key }));
  }
  if (missing.length) {
    for (const r of missing) console.log(t('init.tplMissing', { dst: r.key }));
  }
}

function ensureDeveloper(user?: string): void {
  if (!user) return;
  const file = path.join(getBaseDir(), '.developer');
  if (fs.existsSync(file)) {
    console.log(t('init.developerExists', { name: fs.readFileSync(file, 'utf8').trim(), file }));
  } else {
    fs.writeFileSync(file, `${user}\n`, 'utf8');
    console.log(t('init.developerWritten', { file, name: user }));
  }
}

/**
 * 确保 .nightowl/ 被 .gitignore 忽略。
 *
 * 为什么必须做:init 会在用户项目里铺 .nightowl/(任务池/状态/日志/worktrees)与 .claude/
 * 等 harness 产物。不忽略的话它们全是未跟踪文件,而 worktree cleanup 用
 * `git status --porcelain` 判"现场是否脏",脏了就拒绝清理 —— 每个任务都会留下残留
 * worktree,无人值守下累积到后续合并全部失败。
 *
 * 策略:只追加缺失条目,从不改写用户已有内容;已有 .gitignore 就插在末尾;
 * 没有就新建。用户手删该行后重跑 init 会补回(幂等)。
 */
export const GITIGNORE_MARKER = '# nightowl (agent 工作区状态,不入库)';
export const GITIGNORE_ENTRIES = ['.nightowl/'];

export function ensureGitignore(projectRoot: string): 'created' | 'updated' | 'unchanged' {
  const file = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const lines = existing === null ? [] : existing.split('\n');
  const trimmed = new Set(lines.map((l) => l.trim()));

  // 已忽略则不动(接受 .nightowl 无尾斜杠等等价写法)
  const alreadyIgnored = GITIGNORE_ENTRIES.every(
    (e) => trimmed.has(e) || trimmed.has(e.replace(/\/$/, '')),
  );
  if (alreadyIgnored) return 'unchanged';

  const missing = GITIGNORE_ENTRIES.filter(
    (e) => !trimmed.has(e) && !trimmed.has(e.replace(/\/$/, '')),
  );
  if (existing === null) {
    fs.writeFileSync(file, `${GITIGNORE_MARKER}\n${missing.join('\n')}\n`, 'utf8');
    return 'created';
  }
  // 追加时保证前面有空行分隔,不把新条目粘到用户最后一行后面
  const sep = existing.endsWith('\n') ? '' : '\n';
  const lead = existing.trim().length ? '\n' : '';
  const block = `${sep}${lead}${GITIGNORE_MARKER}\n${missing.join('\n')}\n`;
  fs.writeFileSync(file, existing + block, 'utf8');
  return 'updated';
}

export function createInitCommand(): Command {
  return new Command('init')
    .description(t('init.desc'))
    .option('-u, --user <name>', t('init.userOption'))
    .option('--claude', t('init.claudeOption'))
    .option('--codex', t('init.codexOption'))
    .option('--opencode', t('init.opencodeOption'))
    .option('--antigravity', t('init.antigravityOption'))
    .option('--platform <id>', t('init.platformOption'))
    .option('--scope <scope>', t('init.scopeOption'), 'project')
    .option('--skip-permissions', t('init.skipPermissionsOption'))
    .option('--force', t('init.forceOption'))
    .action((opts: {
      scope: string;
      skipPermissions: boolean;
      user?: string;
      claude?: boolean;
      codex?: boolean;
      opencode?: boolean;
      antigravity?: boolean;
      platform?: string;
      force: boolean;
    }) => {
      const projectRoot = path.dirname(getBaseDir());
      const platform = resolvePlatform(
        opts.platform ?? platformFromFlags(opts),
        projectRoot,
      );

      let created = false;
      if (fs.existsSync(POOL_FILE())) {
        console.log(t('init.alreadyExists', { file: POOL_FILE() }));
      } else {
        ensureBaseDir();
        const pool: Pool = {
          schedule: {
            retry_budget: DEFAULT_RETRY_BUDGET,
          },
          checkpoint: { enabled: true, write_every: 1 },
          pool: [],
        };
        const state: AppState = {
          completed: [],
          blocked: [],
          in_progress: null,
          last_run: null,
          report: null,
        };
        savePool(pool);
        saveState(state);
        if (!fs.existsSync(LOG_FILE())) {
          fs.writeFileSync(LOG_FILE(), '# nightowl log\n', 'utf8');
        }
        created = true;
        log(t('init.ok'));
      }

      // 记录平台,后续 setup-permissions/selfcheck 按它分发
      fs.writeFileSync(PLATFORM_FILE(), `${platform.id}\n`, 'utf8');

      // .nightowl/ 必须被忽略,否则 worktree cleanup 会把 harness 状态误判为未提交改动
      const giResult = ensureGitignore(projectRoot);
      if (giResult !== 'unchanged') {
        console.log(t('init.gitignoreWritten', { action: giResult, entries: GITIGNORE_ENTRIES.join(', ') }));
      }

      if (opts.skipPermissions) {
        console.log(t('init.skippedPermissions'));
      } else {
        printPermissionsResult(platform.writePermissions(projectRoot, opts.scope as 'project' | 'local'), platform.nonInteractiveCmd);
      }

      ensureDeveloper(opts.user);
      installProjectTemplates(platform, opts.force);

      if (created) {
        console.log('');
        console.log(t('init.howToAdd'));
        console.log(t('init.howToAddCmd'));
        console.log(t('init.howToAddExtra'));
      }
      console.log(t('init.viewStatus'));
    });
}
