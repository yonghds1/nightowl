import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlatform, DEFAULT_PLATFORM, claude, codex } from '../src/platforms/index.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-resolve-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolvePlatform 优先级', () => {
  it('显式 codex > 默认', () => {
    expect(resolvePlatform('codex', root)).toBe(codex);
    expect(resolvePlatform('claude', root)).toBe(claude);
  });

  it('.platform 文件记录 > 默认;显式仍优先于文件', () => {
    fs.mkdirSync(path.join(root, '.nightowl'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nightowl', '.platform'), 'codex\n', 'utf8');
    expect(resolvePlatform(undefined, root)).toBe(codex);
    expect(resolvePlatform('claude', root)).toBe(claude);
  });

  it('未知 id 回退 claude', () => {
    expect(resolvePlatform('nope', root)).toBe(claude);
  });

  it('默认 claude', () => {
    expect(DEFAULT_PLATFORM).toBe('claude');
    expect(resolvePlatform(undefined, root)).toBe(claude);
  });
});
