import { t } from '../i18n.js';
import type { PermissionsResult } from '../platforms/types.js';

// 权限模型/hook 配置的宿主实现已移到 platforms/(claude.ts 的 writePermissions)。
// 这里保留 re-export 兼容既有引用(setup-permissions.ts / 测试),及平台无关的结果展示。
export { PERMISSION_RULES, PERMISSION_MODE_HOOKS, applyPermissions } from '../platforms/claude.js';

export function printPermissionsResult(res: PermissionsResult): void {
  if (res.added.length > 0) {
    console.log(t('permissions.added', { n: res.added.length, target: res.target }));
    for (const r of res.added) console.log(`   ${r}`);
  } else {
    console.log(t('permissions.already', { target: res.target }));
  }
  console.log('');
  console.log(t('permissions.reload'));
  console.log(t('permissions.noninteractive'));
  if (res.hooksAdded) {
    console.log('');
    console.log(t('permissions.hookInstalled', { target: res.target }));
  }
}
