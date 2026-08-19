import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Language = 'zh' | 'en';

export const DEFAULT_LANGUAGE: Language = 'zh';
export const SUPPORTED_LANGUAGES: Language[] = ['zh', 'en'];

type Dict = Record<string, unknown>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function load(lang: Language): Dict {
  const file = path.join(__dirname, 'locales', `${lang}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Dict;
}

const zhDict = load('zh');
const enDict = load('en');

function resolve(dict: Dict, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, dict);
}

export function getLanguage(): Language {
  const v = process.env.NIGHTOWL_LANG;
  if (v === 'en') return 'en';
  return DEFAULT_LANGUAGE;
}

/**
 * 翻译:key 形如 "init.ok";vars 替换 {{var}}。
 * 当前语言缺 key 时回退中文,再缺返回 key 本身(开发期可发现)。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = getLanguage();
  let s: unknown = resolve(lang === 'en' ? enDict : zhDict, key);
  if (typeof s !== 'string') s = resolve(zhDict, key);
  if (typeof s !== 'string') return key;
  let out: string = s;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return out;
}
