import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pkgRoot } from '../src/paths.js';

let root: string;
const cli = path.join(pkgRoot(), 'bin/nightowl.js');
function run(args: string[], expected = 0): string {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env: { ...process.env, NIGHTOWL_LANG: 'en' }, encoding: 'utf8', timeout: 20_000,
  });
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(expected);
  return output;
}
function report(): string {
  run(['report']);
  return fs.readFileSync(path.join(root, '.nightowl/nightowl.report.md'), 'utf8');
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-evidence-cli-'));
  run(['init', '--skip-permissions', '--claude', '-u', 'cli-evidence']);
  fs.writeFileSync(path.join(root, 'gate.cjs'), 'process.exit(0);\n');
  run(['add', '--id', 'T1', '--title', 'CLI evidence', '--priority', 'P0', '--est-min', '5', '--verify', 'node gate.cjs']);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('built CLI prevents stale verification completion', () => {
  it('blocks success → review → failure → done, then requires a new review after recovery', () => {
    run(['verify', 'T1']);
    run(['review', 'T1', '--result', 'PASS']);
    fs.writeFileSync(path.join(root, 'gate.cjs'), 'process.exit(1);\n');
    run(['verify', 'T1'], 1);
    run(['done', 'T1'], 1);
    expect(report()).toContain('[Blocked]');
    fs.writeFileSync(path.join(root, 'gate.cjs'), 'process.exit(0);\n');
    run(['verify', 'T1']);
    run(['done', 'T1'], 1);
    run(['review', 'T1', '--result', 'PASS']);
    run(['done', 'T1']);
    const finalReport = report();
    expect(finalReport).toContain('Task evidence passed; release not assessed');
    expect(finalReport).not.toContain('Ready to ship');
    expect(finalReport).toContain('not automatic release authorization');
  });

  it('a failed rerun after completion also blocks idempotent done and a ready report', () => {
    run(['verify', 'T1']);
    run(['review', 'T1', '--result', 'PASS']);
    run(['done', 'T1']);
    fs.writeFileSync(path.join(root, 'gate.cjs'), 'process.exit(1);\n');
    run(['verify', 'T1'], 1);
    run(['done', 'T1'], 1);
    expect(report()).toContain('[Blocked]');
  });
});
