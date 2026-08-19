import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir, getPkgVersion } from '../src/paths.js';
import { savePool } from '../src/state.js';
import { createStatusCommand } from '../src/commands/status.js';
import { runCommand } from './helpers.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-status-'));
  setBaseDir(path.join(root, '.nightowl'));
  savePool({
    schedule: { retry_budget: 2 },
    checkpoint: { enabled: true, write_every: 1 },
    pool: [],
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const HASH_FILE = (): string => path.join(root, '.nightowl', '.template-hashes.json');

function writeHashes(skillsVersion?: string): void {
  const rec: { __version: number; hashes: Record<string, string>; skillsVersion?: string } = {
    __version: 1,
    hashes: { 'x': 'h' },
  };
  if (skillsVersion !== undefined) rec.skillsVersion = skillsVersion;
  fs.writeFileSync(HASH_FILE(), JSON.stringify(rec), 'utf8');
}

describe('status 技能版本自检', () => {
  it('hash 文件缺失(未 init)→ 无提示', () => {
    const r = runCommand(createStatusCommand(), []);
    expect(r.stdout).not.toContain('nightowl init');
    expect(r.output).not.toContain('skillsOutdated');
    expect(r.output).not.toContain('skillsUnversioned');
  });

  it('stamp 落后于当前包 → outdated 提示', () => {
    writeHashes('0.0.1');
    const r = runCommand(createStatusCommand(), []);
    expect(r.output).toContain('v0.0.1 < 当前包 v' + getPkgVersion());
    expect(r.output).toContain('nightowl init');
  });

  it('stamp 等于当前包 → 无提示', () => {
    writeHashes(getPkgVersion());
    const r = runCommand(createStatusCommand(), []);
    expect(r.output).not.toContain('skillsOutdated');
    expect(r.output).not.toContain('skillsUnversioned');
  });

  it('stamp 缺失(旧版 init 产物)→ unversioned 提示', () => {
    writeHashes();
    const r = runCommand(createStatusCommand(), []);
    expect(r.output).toContain('未记录来源版本');
    expect(r.output).toContain('nightowl init');
  });

  it('stamp 新于当前包(回退场景)→ 无提示', () => {
    writeHashes('99.0.0');
    const r = runCommand(createStatusCommand(), []);
    expect(r.output).not.toContain('skillsOutdated');
    expect(r.output).not.toContain('skillsUnversioned');
  });
});