import { Command } from 'commander';
import fs from 'node:fs';
import { PERMISSION_MODE_FILE } from '../paths.js';
import { resolvePlatform } from '../platforms/index.js';
import { t } from '../i18n.js';

const BYPASS = 'bypassPermissions';

/** 读 .nightowl/.permission-mode(PreToolUse hook 写入的实时权限模式);不存在/空 → null。 */
export function readPermissionMode(): string | null {
  const file = PERMISSION_MODE_FILE();
  if (!fs.existsSync(file)) return null;
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

export function createSelfcheckCommand(): Command {
  return new Command('selfcheck')
    .description(t('selfcheck.desc'))
    .action(() => {
      const hook = readPermissionMode();
      // 进程兜底按平台分发(claude: CLAUDE_PID + --dangerously;codex: CODEX_PID + --full-auto)
      const platform = resolvePlatform(undefined, process.cwd());
      let bypass: boolean | null;
      if (hook !== null) {
        bypass = hook === BYPASS;
      } else {
        const d = platform.detectBypass();
        bypass = d === null ? null : d;
      }

      if (bypass === true) {
        console.log('PERMISSION_MODE: bypass');
        console.log(t('selfcheck.bypass'));
      } else if (bypass === false) {
        console.log('PERMISSION_MODE: not_bypass');
        console.log(t('selfcheck.notBypass', { mode: hook ?? 'process', cmd: platform.nonInteractiveCmd }));
      } else {
        console.log('PERMISSION_MODE: unknown');
        console.log(t('selfcheck.unknown'));
      }
    });
}
