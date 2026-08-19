import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE, POOL_FILE, PLATFORM_FILE, ensureBaseDir, getBaseDir, getPkgVersion } from '../paths.js';
import { savePool, saveState, log, type AppState, type Pool } from '../state.js';
import { printPermissionsResult } from './permissions.js';
import { t } from '../i18n.js';
import { resolvePlatform } from '../platforms/index.js';
import type { Platform } from '../platforms/types.js';

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

export function createInitCommand(): Command {
  return new Command('init')
    .description(t('init.desc'))
    .option('-u, --user <name>', t('init.userOption'))
    .option('--claude', t('init.claudeOption'))
    .option('--codex', t('init.codexOption'))
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
      platform?: string;
      force: boolean;
    }) => {
      const projectRoot = path.dirname(getBaseDir());
      const platform = resolvePlatform(
        opts.platform ?? (opts.claude ? 'claude' : opts.codex ? 'codex' : undefined),
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

      if (opts.skipPermissions) {
        console.log(t('init.skippedPermissions'));
      } else {
        printPermissionsResult(platform.writePermissions(projectRoot, opts.scope as 'project' | 'local'));
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
