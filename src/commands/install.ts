import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InstallStatus } from '../platforms/types.js';
import { TEMPLATE_HASHES_FILE } from '../paths.js';

function sha256(file: string): string {
  return sha256Str(fs.readFileSync(file));
}

function sha256Str(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** .template-hashes.json 的 schema:hash 记录 + 技能来源版本戳。 */
export interface TemplateHashes {
  hashes: Record<string, string>;
  /** 铺装时的包版本;旧版 init 产物无此字段。 */
  skillsVersion?: string;
}

/** 读 hash 文件:缺失返回 null;损坏保留现场为 .bak 并返回空记录。 */
export function loadTemplateHashes(db: string = TEMPLATE_HASHES_FILE()): TemplateHashes | null {
  if (!fs.existsSync(db)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(db, 'utf8')) as Partial<TemplateHashes>;
    return { hashes: raw.hashes ?? {}, skillsVersion: raw.skillsVersion };
  } catch {
    fs.copyFileSync(db, `${db}.bak`);
    return { hashes: {} };
  }
}

/** 原子写 hash 文件:先写临时文件再 rename,避免中途崩溃留下截断 JSON。 */
export function saveTemplateHashes(rec: TemplateHashes, db: string = TEMPLATE_HASHES_FILE()): void {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const tmp = `${db}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ __version: 1, skillsVersion: rec.skillsVersion, hashes: rec.hashes }, null, 2), 'utf8');
  fs.renameSync(tmp, db);
}

/**
 * 铺入单个模板文件。返回 'installed' | 'updated' | 'forced' | 'nochange' | 'skipped' | 'missing'。
 * 已存在且内容一致 → nochange;内容不同且未被本地定制 → updated(模板升级);
 * 被本地定制过(记录 hash 与当前 dst 不符)→ skipped(--force 强制覆盖 → forced);
 * 包内源文件缺失(安装损坏)→ missing。
 * transform:铺入前对模板内容做渲染(平台占位替换);hash 一律对"渲染后的产物"计算,
 * 本地定制检测逻辑不变。切换平台重跑 init 时渲染产物变化,走 updated 路径自动重铺。
 */
export function installFile(
  src: string,
  dst: string,
  hashRec: Record<string, string>,
  key: string,
  force: boolean,
  transform?: (content: string) => string,
): InstallStatus {
  if (!fs.existsSync(src)) return 'missing';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const content = transform ? transform(fs.readFileSync(src, 'utf8')) : null;
  const write = (): void => {
    if (content !== null) fs.writeFileSync(dst, content, 'utf8');
    else fs.copyFileSync(src, dst);
  };
  const srcHash = content !== null ? sha256Str(content) : sha256(src);
  if (fs.existsSync(dst)) {
    const dstHash = sha256(dst);
    if (dstHash === srcHash) {
      // 内容一致也登记 hash,保证损坏恢复后重跑能把记录重新铺满
      hashRec[key] = srcHash;
      return 'nochange';
    }
    const rec = hashRec[key];
    if (rec !== undefined && rec === dstHash) {
      // dst 仍是上次铺入的样子,src 变了 → 包升级,覆盖
      write();
      hashRec[key] = srcHash;
      return 'updated';
    }
    if (!force) return 'skipped';
    write();
    hashRec[key] = srcHash;
    return 'forced';
  }
  write();
  hashRec[key] = srcHash;
  return 'installed';
}
