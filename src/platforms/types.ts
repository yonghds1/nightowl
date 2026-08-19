// 宿主投递层抽象:业务核心(任务池/状态/调度)宿主无关,
// 只有"铺装模板 / 写权限 / bypass 检测 / 无交互启动提示"这 4 个能力按宿主实现。

export type InstallStatus = 'installed' | 'updated' | 'forced' | 'nochange' | 'skipped' | 'missing';

export interface InstallItem {
  key: string;
  status: InstallStatus;
}

export interface PermissionsResult {
  added: string[];
  target: string;
  hooksAdded: boolean;
}

export interface HeadlessRun {
  /** 宿主 CLI 可执行名,如 'claude' / 'codex'。 */
  cmd: string;
  /**
   * 组装 headless 无交互运行一个续跑轮次的 argv(prompt 已内含无人值守续跑指令)。
   * useContinue=false 时去掉 --continue(supervise 首轮无历史会话时回退新开)。
   */
  args(prompt: string, useContinue: boolean): string[];
}

export interface Platform {
  /** 唯一标识,写入 .nightowl/.platform,也作为 --platform 的参数值。 */
  id: string;
  /** 显示名(用于提示文案)。 */
  name: string;
  /** 宿主配置目录名,如 '.claude' / '.codex'。 */
  configDir: string;
  /** 把 skills / 斜杠命令 / hook 脚本铺到目标项目的宿主目录(复用 installFile 的 hash 机制)。 */
  installTemplates(
    projectRoot: string,
    hashRec: Record<string, string>,
    force: boolean,
  ): InstallItem[];
  /** 写入权限配置(Claude: settings.json 命令白名单;Codex: config.toml approval_policy + hooks.json)。 */
  writePermissions(projectRoot: string, scope: 'project' | 'local'): PermissionsResult;
  /** 进程兜底检测 bypass(无 hook 文件时)。true=bypass,false=非, null=无法检测。 */
  detectBypass(): boolean | null;
  /** 无交互启动命令(用于提示文案)。 */
  nonInteractiveCmd: string;
  /** 无人值守 headless 驱动(supervise 用)。未实现(如 codex)则为 undefined。 */
  headlessRun?: HeadlessRun;
}
