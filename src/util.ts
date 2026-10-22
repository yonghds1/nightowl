// 通用工具:slug 转换、时间格式化、日志

import fs from 'node:fs';

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

/** 本地时区 ISO 串(不带 Z),供状态文件与日志使用。 */
export function isoOf(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 避免 JS toISOString 的 UTC 行为,手工拼本地时区 ISO 字符串。 */
export function isoNow(): string {
  return isoOf(new Date());
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

/**
 * 日志/状态文件超阈值时改名 .1(只保留最近一份)。
 * 轮转失败不能阻塞写日志,所以一律吞掉异常。
 */
export function rotateFileIfLarge(file: string, maxBytes: number): void {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= maxBytes) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* 轮转是尽力而为 */
  }
}

const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/** 解析 isoNow() 产出的本地时间串(无时区后缀);非法/溢出(如 02-30)返回 null。 */
export function parseLocalIso(value: string): Date | null {
  const m = LOCAL_ISO_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms ?? 0),
  );
  // 回读校验,拒绝 Date 自动进位的非法日期
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d) ||
    date.getHours() !== Number(h) ||
    date.getMinutes() !== Number(mi)
  ) {
    return null;
  }
  return date;
}

/**
 * 从 started_at 到 end 的实际分钟数(向上取整到分钟,最少 1 分钟)。
 * 用于 done 自动记录 actual_min,避免"没传就等于预估"导致工时偏差恒为 0。
 * 非法/未来时间返回 null,由调用方回退。
 */
export function minutesBetween(startIso: string, end: Date = new Date()): number | null {
  const start = parseLocalIso(startIso);
  if (!start) return null;
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.round(ms / 60_000));
}
