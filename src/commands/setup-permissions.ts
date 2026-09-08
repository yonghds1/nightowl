import { Command } from 'commander';
import { printPermissionsResult } from './permissions.js';
import { resolvePlatform, platformFromFlags } from '../platforms/index.js';
import { t } from '../i18n.js';

export function createSetupPermissionsCommand(): Command {
  return new Command('setup-permissions')
    .description(t('permissions.setupDesc'))
    .option('--scope <scope>', t('permissions.scopeOption'), 'project')
    .option('--claude', t('init.claudeOption'))
    .option('--codex', t('init.codexOption'))
    .option('--opencode', t('init.opencodeOption'))
    .option('--antigravity', t('init.antigravityOption'))
    .option('--platform <id>', t('init.platformOption'))
    .action((opts: {
      scope: string;
      claude?: boolean;
      codex?: boolean;
      opencode?: boolean;
      antigravity?: boolean;
      platform?: string;
    }) => {
      const root = process.cwd();
      const platform = resolvePlatform(
        opts.platform ?? platformFromFlags(opts),
        root,
      );
      printPermissionsResult(platform.writePermissions(root, opts.scope as 'project' | 'local'), platform.nonInteractiveCmd);
    });
}
