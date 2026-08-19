import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplateHashes, saveTemplateHashes } from '../src/commands/install.js';
import { semverLt } from '../src/util.js';

let root: string;
let db: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-hash-'));
  db = path.join(root, '.template-hashes.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadTemplateHashes / saveTemplateHashes', () => {
  it('文件缺失 → null', () => {
    expect(loadTemplateHashes(db)).toBeNull();
  });

  it('save → load round-trip(stamp + hashes 保留)', () => {
    saveTemplateHashes({ hashes: { a: 'h1' }, skillsVersion: '0.3.1' }, db);
    const loaded = loadTemplateHashes(db);
    expect(loaded).toEqual({ hashes: { a: 'h1' }, skillsVersion: '0.3.1' });
  });

  it('旧格式(无 skillsVersion)load → stamp undefined,hashes 保留', () => {
    fs.writeFileSync(db, JSON.stringify({ __version: 1, hashes: { a: 'h1' } }), 'utf8');
    const loaded = loadTemplateHashes(db);
    expect(loaded).toEqual({ hashes: { a: 'h1' }, skillsVersion: undefined });
  });

  it('损坏 → 生成 .bak + 返回空记录', () => {
    fs.writeFileSync(db, '{{{broken json', 'utf8');
    const loaded = loadTemplateHashes(db);
    expect(loaded).toEqual({ hashes: {} });
    expect(fs.existsSync(`${db}.bak`)).toBe(true);
  });

  it('无损保存原 content(原子写格式:__version + skillsVersion + hashes)', () => {
    saveTemplateHashes({ hashes: { a: 'h1' }, skillsVersion: '0.2.0' }, db);
    expect(fs.existsSync(`${db}.tmp`)).toBe(false); // tmp 已 rename
    const raw = JSON.parse(fs.readFileSync(db, 'utf8'));
    expect(raw.__version).toBe(1);
    expect(raw.skillsVersion).toBe('0.2.0');
    expect(raw.hashes).toEqual({ a: 'h1' });
  });
});

describe('semverLt', () => {
  it.each([
    ['0.1.0', '0.2.0', true],
    ['0.3.1', '0.3.1', false],
    ['0.3.2', '0.3.1', false],
    ['1.0.0', '0.9.9', false],
    ['0.3.1', '0.3.10', true], // patch 按数字比较,非字符串
    ['0.3.1-alpha.1', '0.3.1', false], // 预发布段忽略(仅前 3 段)
    ['0.3.1-beta', '0.3.1-alpha', false], // 同 major.minor.patch,预发布段不比较
  ])('semverLt(%s, %s) === %s', (a, b, expected) => {
    expect(semverLt(a, b)).toBe(expected);
  });

  it('段不可解析时回落字符串比较', () => {
    expect(semverLt('dev', 'dev')).toBe(false);
    expect(semverLt('a', 'b')).toBe(true);
    expect(semverLt('b', 'a')).toBe(false);
  });
});