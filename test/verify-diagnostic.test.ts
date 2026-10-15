import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { runCommand } from './helpers.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand, extractDiagnostic } from '../src/commands/verify.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-verify-'));
  setBaseDir(path.join(root, '.nightowl'));
  runCommand(createInitCommand(), ['--skip-permissions']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extractDiagnostic', () => {
  it('短输出保留完整内容', () => {
    const out = 'line 1\nFAIL: something\nError: expected true\nline 4';
    expect(extractDiagnostic(out, '')).toBe(out);
  });

  it('合并 stdout 与 stderr', () => {
    const out = 'stdout line';
    const err = 'stderr line';
    expect(extractDiagnostic(out, err)).toBe('stdout line\nstderr line');
  });

  it('空输出返回空字符串', () => {
    expect(extractDiagnostic('', '')).toBe('');
  });

  it('长输出智能保留尾部与关键行', () => {
    const filler = 'x'.repeat(120);
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(`line ${String(i).padStart(2, '0')}: ${filler}`);
    }
    lines[5] = 'FAIL: module A did not load';
    lines[6] = '  Error: timeout after 5000ms';
    lines[7] = '    at /path/to/file.ts:10:5';
    lines[42] = 'some middle noise';
    for (let i = 0; i < 30; i++) {
      lines.push(`tail ${String(i).padStart(2, '0')}: ${filler}`);
    }
    const combined = lines.join('\n');
    expect(combined.length).toBeGreaterThan(2000);

    const diag = extractDiagnostic(combined, '');
    expect(diag).toContain('FAIL: module A did not load');
    expect(diag).toContain('Error: timeout after 5000ms');
    expect(diag).toContain('tail 29:');
    expect(diag).not.toContain('line 42:');
    expect(diag).not.toContain('some middle noise');
  });

  it('stderr 关键行也会被提取', () => {
    const stdout = Array.from({ length: 50 }, (_, i) => `stdout ${i}: ${'z'.repeat(80)}`).join('\n');
    const stderr = 'ERROR: database connection refused\nFailed: setup step';
    const combined = `${stdout}\n${stderr}`;
    expect(combined.length).toBeGreaterThan(2000);

    const diag = extractDiagnostic(stdout, stderr);
    expect(diag).toContain('ERROR: database connection refused');
    expect(diag).toContain('Failed: setup step');
    expect(diag).toContain('stdout 49');
  });

  it('无关键行时仅保留尾部', () => {
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      lines.push(`line ${i}: ${'y'.repeat(80)}`);
    }
    const combined = lines.join('\n');
    expect(combined.length).toBeGreaterThan(2000);

    const diag = extractDiagnostic(combined, '');
    expect(diag).not.toContain('...(关键错误摘要)...');
    expect(diag).toContain('line 79:');
    expect(diag).not.toContain('line 40:');
  });

  it('不截断单行', () => {
    const longLine = 'A'.repeat(2500);
    const combined = `start\n${longLine}\nFAIL: oops\n${longLine}\nend`;
    expect(combined.length).toBeGreaterThan(2000);

    const diag = extractDiagnostic(combined, '');
    expect(diag).toContain('FAIL: oops');
    expect(diag).toContain(longLine);
  });
});

describe('verify --cwd', () => {
  it('--cwd 指定工作目录时命令在该目录执行', () => {
    const marker = path.join(root, 'cwd-marker.txt');
    const targetCwd = path.join(root, 'target-workspace');
    fs.mkdirSync(targetCwd);
    runCommand(createAddCommand(), [
      '--id', 'T1', '--title', 'Cwd task', '--priority', 'P0', '--est-min', '15',
      '--verify', `pwd > "${marker}"`,
    ]);
    const r = runCommand(createVerifyCommand(), ['T1', '--cwd', targetCwd]);
    expect(r.exitCode).toBeUndefined();
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(targetCwd);
  });
});
