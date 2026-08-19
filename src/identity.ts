import fs from 'node:fs';
import path from 'node:path';
import { getBaseDir } from './paths.js';

export const DEFAULT_IDENTITY = 'nightowl-user';

/** 读取开发者身份:`.developer` 存在读名字(取首行),否则回落默认用户。 */
export function getIdentity(): string {
  const file = path.join(getBaseDir(), '.developer');
  if (fs.existsSync(file)) {
    const name = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    if (name) return name;
  }
  return DEFAULT_IDENTITY;
}
