// 通用工具:slug 转换、时间格式化、日志

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** 转 ASCII slug:小写,非 [a-z0-9-] 替换为 -,压缩连续 -,去首尾 -。 */
export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return slug.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

/** 文件系统安全段:保留 unicode,替换路径分隔符/控制字符为 -,trim 首尾空格/点;空返回空串。 */
export function safeSegment(name: string): string {
  return name.replace(/[\/\\\x00-\x1f]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '');
}

/** 避免 JS toISOString 的 UTC 行为,手工拼本地时区 ISO 字符串。 */
export function isoNow(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 日志时间戳:YYYY-MM-DD HH:MM:SS */
export function fmtDateTime(d = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** PRD 目录前缀:MM-DD */
export function datePrefix(d = new Date()): string {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 报告生成时间行:YYYY-MM-DD HH:MM:SS */
export const reportTime = (): string => fmtDateTime();

/** 简易 semver 比较:maj.minor.patch 按数字段比,前 3 段之后忽略;段无法解析时回落字符串比较。 */
export function semverLt(a: string, b: string): boolean {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < 3; i++) {
    const na = Number.parseInt(pa[i], 10);
    const nb = Number.parseInt(pb[i], 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb;
      continue;
    }
    return a < b;
  }
  return false;
}
