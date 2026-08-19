import { Command } from 'commander';
import { printPermissionsResult } from './permissions.js';
import { resolvePlatform } from '../platforms/index.js';
import { t } from '../i18n.js';

export function createSetupPermissionsCommand(): Command {
  return new Command('setup-permissions')
    .description(t('permissions.setupDesc'))
    .option('--scope <scope>', t('permissions.scopeOption'), 'project')
    .option('--claude', t('init.claudeOption'))
    .option('--codex', t('init.codexOption'))
    .option('--platform <id>', t('init.platformOption'))
    .action((opts: { scope: string; claude?: boolean; codex?: boolean; platform?: string }) => {
      const root = process.cwd();
      const platform = resolvePlatform(
        opts.platform ?? (opts.claude ? 'claude' : opts.codex ? 'codex' : undefined),
        root,
      );
      printPermissionsResult(platform.writePermissions(root, opts.scope as 'project' | 'local'));
    });
}
