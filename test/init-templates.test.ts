import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFile, installProjectTemplates } from '../src/commands/init.js';
import { setBaseDir, getPkgVersion } from '../src/paths.js';
import { claude } from '../src/platforms/claude.js';

let root: string;
let srcFile: string;
let dstFile: string;
let hashRec: Record<string, string>;
const KEY = '.claude/skills/nightowl-test/SKILL.md';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-init-'));
  srcFile = path.join(root, 'src.md');
  dstFile = path.join(root, 'dst.md');
  hashRec = {};
  fs.writeFileSync(srcFile, 'template v1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('installFile 幂等/升级/定制保护', () => {
  it('目标不存在 → installed + 记录 hash', () => {
    const s = installFile(srcFile, dstFile, hashRec, KEY, false);
    expect(s).toBe('installed');
    expect(fs.readFileSync(dstFile, 'utf8')).toBe('template v1');
    expect(hashRec[KEY]).toBeTruthy();
  });

  it('内容一致 → nochange', () => {
    installFile(srcFile, dstFile, hashRec, KEY, false);
    expect(installFile(srcFile, dstFile, hashRec, KEY, false)).toBe('nochange');
  });

  it('nochange 时登记 hash(损坏恢复后重跑能重新铺满记录)', () => {
    // 模拟 hash 文件损坏:记录为空,但 dst 已铺入且与 src 一致
    fs.copyFileSync(srcFile, dstFile);
    expect(installFile(srcFile, dstFile, hashRec, KEY, false)).toBe('nochange');
    expect(hashRec[KEY]).toBeTruthy();
  });

  it('src 升级且 dst 未定制 → updated(包升级)', () => {
    installFile(srcFile, dstFile, hashRec, KEY, false);
    fs.writeFileSync(srcFile, 'template v2');
    expect(installFile(srcFile, dstFile, hashRec, KEY, false)).toBe('updated');
    expect(fs.readFileSync(dstFile, 'utf8')).toBe('template v2');
  });

  it('本地定制 → skipped,不动 dst', () => {
    installFile(srcFile, dstFile, hashRec, KEY, false);
    fs.writeFileSync(dstFile, 'local edit');
    expect(installFile(srcFile, dstFile, hashRec, KEY, false)).toBe('skipped');
    expect(fs.readFileSync(dstFile, 'utf8')).toBe('local edit');
  });

  it('--force 覆盖定制 → forced,渲染为覆盖文案', () => {
    installFile(srcFile, dstFile, hashRec, KEY, false);
    fs.writeFileSync(dstFile, 'local edit');
    expect(installFile(srcFile, dstFile, hashRec, KEY, true)).toBe('forced');
    expect(fs.readFileSync(dstFile, 'utf8')).toBe('template v1');
  });

  it('src 缺失 → missing', () => {
    expect(installFile(path.join(root, 'nope.md'), dstFile, hashRec, KEY, false)).toBe('missing');
  });
});

describe('installProjectTemplates 版本戳', () => {
  it('铺装后写入当前包版本戳', () => {
    setBaseDir(path.join(root, '.nightowl'));
    installProjectTemplates(claude, false);
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, '.nightowl', '.template-hashes.json'), 'utf8'),
    );
    expect(raw.skillsVersion).toBe(getPkgVersion());
  });

  it('旧格式(无 skillsVersion)重跑 → 补齐版本戳且旧 hashes 保留', () => {
    setBaseDir(path.join(root, '.nightowl'));
    const db = path.join(root, '.nightowl', '.template-hashes.json');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, JSON.stringify({ __version: 1, hashes: { 'legacy-key': 'old-hash' } }), 'utf8');
    installProjectTemplates(claude, false);
    const raw = JSON.parse(fs.readFileSync(db, 'utf8'));
    expect(raw.skillsVersion).toBe(getPkgVersion());
    expect(raw.hashes['legacy-key']).toBe('old-hash');
  });
});
