import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBaseDir } from '../src/paths.js';
import { createInitCommand } from '../src/commands/init.js';
import { createAddCommand } from '../src/commands/add.js';
import { createVerifyCommand } from '../src/commands/verify.js';
import { createReviewCommand } from '../src/commands/review.js';
import { createDoneCommand } from '../src/commands/done.js';
import { buildExecutiveSummary } from '../src/commands/report.js';
import { loadPool, loadState, updatePool } from '../src/state.js';
import { runCommand } from './helpers.js';

let root: string;
let cwd: string;
const env = { ...process.env };
const verify = () => runCommand(createVerifyCommand(), ['T1']);
const review = () => runCommand(createReviewCommand(), ['T1', '--result', 'PASS']);
const done = () => runCommand(createDoneCommand(), ['T1']);
const summary = () => buildExecutiveSummary(loadPool()!, loadState());

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-evidence-'));
  cwd = process.cwd();
  process.chdir(root);
  process.env.NIGHTOWL_LANG = 'en';
  setBaseDir(path.join(root, '.nightowl'));
  runCommand(createInitCommand(), ['--skip-permissions', '--claude', '-u', 'evidence']);
  fs.writeFileSync('gate.cjs', 'process.exit(0);\n');
  runCommand(createAddCommand(), ['--id', 'T1', '--title', 'Evidence test', '--priority', 'P0', '--est-min', '5', '--verify', 'node gate.cjs']);
});
afterEach(() => {
  process.chdir(cwd);
  process.env = { ...env };
  fs.rmSync(root, { recursive: true, force: true });
});

describe('verification evidence lifecycle', () => {
  it('success, review, then failed recheck cannot reuse the old pass', () => {
    expect(verify().output).toContain('ALL_PASS');
    review();
    fs.writeFileSync('gate.cjs', 'process.exit(1);\n');
    expect(verify().exitCode).toBe(1);
    expect(loadPool()!.pool[0].verify_passed).toBeUndefined();
    expect(done().exitCode).toBe(1);
    expect(loadState().completed).toEqual([]);
  });

  it('each successful rerun requires review of that particular run', () => {
    verify();
    review();
    expect(verify().output).toContain('ALL_PASS');
    expect(done().exitCode).toBe(1);
    review();
    expect(done().exitCode).toBeUndefined();
  });

  it('changed verification commands invalidate the receipt and review', () => {
    verify();
    review();
    updatePool((pool) => { pool.pool[0].verify = ['node --check gate.cjs']; });
    expect(done().exitCode).toBe(1);
    expect(summary().verdict).not.toBe('READY');
  });

  it('a completed task with a newly failed verification cannot be reported ready', () => {
    verify(); review(); done();
    fs.writeFileSync('gate.cjs', 'process.exit(1);\n');
    expect(verify().exitCode).toBe(1);
    expect(summary().verdict).toBe('BLOCKED');
    expect(done().exitCode).toBe(1);
  });

  it('forced completion without evidence is not reported ready', () => {
    runCommand(createDoneCommand(), ['T1', '--force']);
    expect(summary().verdict).not.toBe('READY');
  });

  it('legacy receipt and review without run linkage require fresh evidence', () => {
    updatePool((pool) => {
      pool.pool[0].verify_passed = { at: 'old', commands: ['node gate.cjs'] };
      pool.pool[0].review = { at: 'old', result: 'PASS', level: 'full', note: '' };
    });
    expect(done().exitCode).toBe(1);
    verify(); review();
    expect(done().exitCode).toBeUndefined();
  });

  it('no mandatory tests on non-P0 pending tasks still prevents a ready verdict', () => {
    verify(); review(); done();
    runCommand(createAddCommand(), ['--id', 'T2', '--title', 'Pending P1', '--priority', 'P1', '--est-min', '5']);
    expect(summary().verdict).not.toBe('READY');
  });
});

// Direct state-level tests keep ordering deterministic without relying on timing.
describe('overlapping verification runs', () => {
  it('an older success or failure cannot overwrite a newer run', async () => {
    const { beginVerification, finishVerification } = await import('../src/evidence.js');
    const commands = ['node gate.cjs'];
    const first = beginVerification('T1', commands)!;
    const second = beginVerification('T1', commands)!;
    let obsoleteCallbackRan = false;
    expect(finishVerification('T1', first, { at: 'old', commands }, () => { obsoleteCallbackRan = true; })).toBe(false);
    expect(obsoleteCallbackRan).toBe(false);
    expect(finishVerification('T1', second, { at: 'new', commands })).toBe(true);
    expect(finishVerification('T1', first)).toBe(false);
    expect(loadPool()!.pool[0].verify_passed?.run_id).toBe(second);
    review();
    expect(done().exitCode).toBeUndefined();
  });

  it('a running newer verification invalidates an already passing older receipt', async () => {
    verify(); review();
    const { beginVerification } = await import('../src/evidence.js');
    expect(beginVerification('T1', ['node gate.cjs'])).toBeTruthy();
    expect(loadPool()!.pool[0].verify_passed).toBeUndefined();
    expect(done().exitCode).toBe(1);
    expect(summary().verdict).toBe('BLOCKED');
  });

  it('commands edited while running cannot publish a pass', async () => {
    const { beginVerification, finishVerification } = await import('../src/evidence.js');
    const commands = ['node gate.cjs'];
    const run = beginVerification('T1', commands)!;
    updatePool((pool) => { pool.pool[0].verify = ['false']; });
    expect(finishVerification('T1', run, { at: 'now', commands })).toBe(false);
    expect(loadPool()!.pool[0].verification_run?.status).toBe('failed');
    expect(loadPool()!.pool[0].verify_passed).toBeUndefined();
  });
});


describe('publication failures are conservative', () => {
  it('a failed receipt publication leaves running evidence, never an old pass', async () => {
    verify(); review();
    const { beginVerification, finishVerification } = await import('../src/evidence.js');
    const commands = ['node gate.cjs'];
    const id = beginVerification('T1', commands)!;
    expect(() => finishVerification('T1', id, { at: 'now', commands }, () => {
      throw new Error('cannot publish feedback');
    })).toThrow('cannot publish feedback');
    expect(loadPool()!.pool[0].verify_passed).toBeUndefined();
    expect(loadPool()!.pool[0].verification_run?.status).toBe('running');
    expect(done().exitCode).toBe(1);
  });
});
