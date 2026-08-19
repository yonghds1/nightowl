import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { getIdentity, DEFAULT_IDENTITY } from '../src/identity.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-ident-'));
  setBaseDir(path.join(root, '.nightowl'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function devFile(): string {
  return path.join(root, '.nightowl', '.developer');
}

describe('getIdentity', () => {
  it('无 .developer → 默认用户 nightowl-user', () => {
    expect(DEFAULT_IDENTITY).toBe('nightowl-user');
    expect(getIdentity()).toBe(DEFAULT_IDENTITY);
  });

  it('.developer 存在 → 读名字', () => {
    fs.mkdirSync(path.dirname(devFile()), { recursive: true });
    fs.writeFileSync(devFile(), '李四\n');
    expect(getIdentity()).toBe('李四');
  });

  it('空文件 → 默认用户', () => {
    fs.mkdirSync(path.dirname(devFile()), { recursive: true });
    fs.writeFileSync(devFile(), '');
    expect(getIdentity()).toBe(DEFAULT_IDENTITY);
  });

  it('全空格 → 默认用户', () => {
    fs.mkdirSync(path.dirname(devFile()), { recursive: true });
    fs.writeFileSync(devFile(), '   \n');
    expect(getIdentity()).toBe(DEFAULT_IDENTITY);
  });

  it('多行取首行', () => {
    fs.mkdirSync(path.dirname(devFile()), { recursive: true });
    fs.writeFileSync(devFile(), '张三\n李四\n');
    expect(getIdentity()).toBe('张三');
  });
});
