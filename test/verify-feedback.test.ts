import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from './helpers.js';
import { createVerifyCommand, getTaskFeedbackPath } from '../src/commands/verify.js';
import { setBaseDir } from '../src/paths.js';
import { savePool } from '../src/state.js';

describe('verify feedback 与版本绑定', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-feedback-test-'));
    setBaseDir(path.join(tmpDir, '.nightowl'));
    fs.mkdirSync(path.join(tmpDir, '.nightowl'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('命令失败时真实写入 feedback.json', () => {
    savePool({
      schedule: { retry_budget: 3 },
      pool: [
        {
          id: 'T1',
          title: 'Fail task',
          priority: 'P1',
          est_min: 10,
          depends_on: [],
          status: 'pending',
          verify: ['sh -c "echo Critical error occurred; exit 2"'],
        },
      ],
    });

    const res = runCommand(createVerifyCommand(), ['--id', 'T1']);
    expect(res.exitCode).toBe(1);

    const fbPath = getTaskFeedbackPath('T1');
    expect(fs.existsSync(fbPath)).toBe(true);
    const fbContent = JSON.parse(fs.readFileSync(fbPath, 'utf8'));
    expect(fbContent.taskId).toBe('T1');
    expect(fbContent.status).toBe('FAILED');
    expect(fbContent.exitCode).toBe(2);
    expect(fbContent.diagnostic).toContain('Critical error occurred');
  });

  it('命令成功时清理 feedback.json 并记录 verify_passed', () => {
    // 先手动放一个旧 feedback
    const fbPath = getTaskFeedbackPath('T2');
    fs.mkdirSync(path.dirname(fbPath), { recursive: true });
    fs.writeFileSync(fbPath, '{"old": true}');

    savePool({
      schedule: { retry_budget: 3 },
      pool: [
        {
          id: 'T2',
          title: 'Pass task',
          priority: 'P1',
          est_min: 10,
          depends_on: [],
          status: 'pending',
          verify: ['echo All tests passed'],
        },
      ],
    });

    const res = runCommand(createVerifyCommand(), ['--id', 'T2']);
    expect(res.stdout).toContain('ALL_PASS');
    expect(fs.existsSync(fbPath)).toBe(false);
  });
});
