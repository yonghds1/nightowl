import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// .nightowl/ 状态目录:默认惰性取当前工作目录(cli 的 --dir 经 preAction chdir 决定)。
// baseDir 保持 null 时每次 getBaseDir() 现算 cwd —— 这样 preAction 的 chdir 生效,
// `nightowl --dir <根>` 才能读写目标目录。测试通过 setBaseDir() 注入临时目录,避免污染真实项目。
let baseDir: string | null = null;

export function setBaseDir(dir: string): void {
  baseDir = dir;
}

export function getBaseDir(): string {
  return baseDir ?? path.join(process.cwd(), '.nightowl');
}

export const POOL_FILE = (): string => path.join(getBaseDir(), 'nightowl.tasks.yaml');
export const STATE_FILE = (): string => path.join(getBaseDir(), 'nightowl.state.yaml');
export const LOG_FILE = (): string => path.join(getBaseDir(), 'nightowl.log');
export const SUPERVISOR_LOG = (): string => path.join(getBaseDir(), 'nightowl.supervisor.log');
export const REPORT_FILE = (): string => path.join(getBaseDir(), 'nightowl.report.md');
export const CHECKPOINT_FILE = (): string => path.join(getBaseDir(), 'nightowl.checkpoint.yaml');
export const CHECKPOINT_BACKUP = (): string => path.join(getBaseDir(), 'nightowl.checkpoint.yaml.backup');
export const CONTEXT_FILE = (): string => path.join(getBaseDir(), 'nightowl.context.md');
export const PERMISSION_MODE_FILE = (): string => path.join(getBaseDir(), '.permission-mode');
export const PLATFORM_FILE = (): string => path.join(getBaseDir(), '.platform');
export const TASKS_DIR = (): string => path.join(getBaseDir(), 'tasks');

export function ensureBaseDir(): void {
  fs.mkdirSync(getBaseDir(), { recursive: true });
  fs.mkdirSync(TASKS_DIR(), { recursive: true });
}

// 包根目录:dist/paths.js 上一级(编译后);tsx 直接跑 src/paths.ts 时同样成立。
export function pkgRoot(): string {
  return path.resolve(fileURLToPath(new URL('../', import.meta.url)));
}

// 模板 hash 记录(.template-hashes.json):记录每个铺入文件的 hash 与技能来源版本,
// 用于 .claude/skills 升级检测(installFile 的 updated 分支)与 status 的版本自检。
export const TEMPLATE_HASHES_FILE = (): string => path.join(getBaseDir(), '.template-hashes.json');

let pkgVersion: string | null = null;

/** 包版本:从 package.json 懒读一次并缓存(version 在运行期不变)。 */
export function getPkgVersion(): string {
  if (pkgVersion === null) {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot(), 'package.json'), 'utf8')) as { version?: string };
    pkgVersion = pkg.version ?? '0.0.0';
  }
  return pkgVersion;
}
