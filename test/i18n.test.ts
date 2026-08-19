import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pkgRoot } from '../src/paths.js';

type Dict = Record<string, unknown>;

function load(lang: string): Dict {
  const file = path.join(pkgRoot(), 'src', 'locales', `${lang}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Dict;
}

function flattenKeys(dict: Dict, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(dict)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') keys.push(...flattenKeys(v as Dict, key));
    else keys.push(key);
  }
  return keys;
}

describe('i18n key 对称性(zh/en key 集完全一致)', () => {
  const zhKeys = new Set(flattenKeys(load('zh')));
  const enKeys = new Set(flattenKeys(load('en')));
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k)).sort();

  it('en 缺失 zh 的 key → 英文用户会看到裸 key', () => {
    expect(onlyZh, `zh.json 有而 en.json 没有: ${onlyZh.join(', ')}`).toEqual([]);
  });

  it('zh 缺失 en 的 key → 静默回退中文,英文用户看到中文文案', () => {
    expect(onlyEn, `en.json 有而 zh.json 没有: ${onlyEn.join(', ')}`).toEqual([]);
  });
});