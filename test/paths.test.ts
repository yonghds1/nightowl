import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBaseDir, setBaseDir } from '../src/paths.js';

describe('paths baseDir 惰性', () => {
  afterEach(() => {
    // 重置惰性状态,避免影响本文件其他用例
    process.chdir('/');
  });

  it('未 setBaseDir 时 getBaseDir 取当前 cwd/.nightowl', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-paths-'));
    process.chdir(dir);
    expect(getBaseDir()).toBe(path.join(dir, '.nightowl'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('chdir 后 getBaseDir 跟随新 cwd(--dir 修复的根基)', () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-paths1-'));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-paths2-'));
    process.chdir(d1);
    expect(getBaseDir()).toBe(path.join(d1, '.nightowl'));
    process.chdir(d2);
    expect(getBaseDir()).toBe(path.join(d2, '.nightowl'));
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  });

  it('setBaseDir 注入后固定,不受 chdir 影响', () => {
    const fixed = path.join(os.tmpdir(), 'nightowl-fixed');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-other-'));
    setBaseDir(fixed);
    process.chdir(other);
    expect(getBaseDir()).toBe(fixed);
    fs.rmSync(other, { recursive: true, force: true });
  });
});
