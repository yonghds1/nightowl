import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeGit } from '../src/git.js';
import { discoverWorkspace } from '../src/workspace.js';
import { runPreflight } from '../src/commands/preflight.js';
import { setBaseDir } from '../src/paths.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let root: string;
let prevCwd: string;
const errors = [
  { code: 'ENOENT' },
  { code: 'EACCES' },
  { code: 'ETIMEDOUT', signal: 'SIGTERM' },
  { status: 128, stderr: 'fatal: detected dubious ownership in repository' },
];
beforeEach(() => {
  prevCwd = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-workspace-failure-'));
  process.chdir(root);
  fs.mkdirSync(path.join(root, '.nightowl'));
  setBaseDir(path.join(root, '.nightowl'));
});
afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Git infrastructure failures are never downgraded', () => {
  it.each(errors)('fails closed for %j', (details) => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('git unavailable'), details); });
    expect(() => probeGit(root)).toThrow();
    expect(discoverWorkspace(root).errors.length).toBeGreaterThan(0);
    expect(runPreflight().some((c) => c.level === 'fail')).toBe(true);
  });

  it('only the exact missing-repository diagnostic permits downgrade', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('not repository'), {
        status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      });
    });
    expect(probeGit(root).isRepo).toBe(false);
    fs.mkdirSync(path.join(root, '.git'));
    expect(() => probeGit(root)).toThrow();
  });
});
