import fs from 'node:fs';
import path from 'node:path';
import { claude } from './claude.js';
import { codex } from './codex.js';
import type { Platform } from './types.js';

const REGISTRY: Record<string, Platform> = { claude, codex };

export const DEFAULT_PLATFORM = 'claude';

/** 平台解析优先级:显式 opt > .nightowl/.platform 记录 > 默认 claude。未知 id 回退 claude。 */
export function resolvePlatform(opt?: string, projectRoot?: string): Platform {
  const root = projectRoot ?? process.cwd();
  const file = path.join(root, '.nightowl', '.platform');
  let saved: string | undefined;
  if (fs.existsSync(file)) {
    try {
      saved = fs.readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      saved = undefined;
    }
  }
  const id = opt || saved || DEFAULT_PLATFORM;
  return REGISTRY[id] ?? claude;
}
