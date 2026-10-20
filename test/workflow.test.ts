import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { POOL_FILE, STATE_FILE, WORKFLOW_FILE, setBaseDir } from '../src/paths.js';
import {
  loadPool, loadState, loadWorkflow, savePool, saveState, saveWorkflow, workflowToPool,
  type AppState, type Pool, type Task, type Workflow,
} from '../src/state.js';
import { createWorkflowCommand } from '../src/commands/workflow.js';
import { COMMAND_FACTORIES } from '../src/commands/registry.js';
import { createNextCommand } from '../src/commands/next.js';
import { runCommand } from './helpers.js';
import { createWorkflowFromIntent } from '../src/workflow-templates.js';

let root: string;
const originalLanguage = process.env.NIGHTOWL_LANG;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-workflow-'));
  setBaseDir(path.join(root, '.nightowl'));
  delete process.env.NIGHTOWL_LANG;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLanguage === undefined) delete process.env.NIGHTOWL_LANG;
  else process.env.NIGHTOWL_LANG = originalLanguage;
  fs.rmSync(root, { recursive: true, force: true });
});

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, priority: 'P1', est_min: 10, status: 'pending', depends_on: [], ...extra };
}

function workflow(): Workflow {
  return {
    name: 'Feature delivery',
    description: 'Implement and review a feature',
    stages: [
      {
        id: 'implement', name: 'Implementation', agent: 'developer',
        tasks: [task('CODE-A'), task('CODE-B')],
        gate_commands: ['npm run typecheck'],
      },
      {
        id: 'review', name: 'Review', agent: 'reviewer',
        depends_on: ['implement', 'implement'],
        gate_commands: ['npm test', 'npm test'],
        tasks: [task('REVIEW', {
          assignee: 'overridden', depends_on: ['CODE-A', 'CODE-A'],
          verify: ['npm run lint', 'npm test'], description: 'Review code', acceptance: 'Tests pass',
        })],
      },
    ],
  };
}

function inputFile(value: unknown = workflow()): string {
  const file = path.join(root, 'workflow.yaml');
  fs.writeFileSync(file, yaml.dump(value));
  return file;
}

function seedPool(): Pool {
  const pool: Pool = {
    schedule: { retry_budget: 7 }, checkpoint: { enabled: false, write_every: 3 }, pool: [task('OLD')],
  };
  savePool(pool);
  return pool;
}

function seedState(): AppState {
  const state: AppState = {
    completed: [{ id: 'OLD', actual_min: 12, finished_at: '2026-10-19T00:00:00Z' }],
    blocked: [{ id: 'BLOCKED', reason: 'existing reason', blocked_at: '2026-10-19T00:00:00Z' }],
    in_progress: { id: 'ACTIVE', started_at: '2026-10-19T00:00:00Z' },
    last_run: '2026-10-19', report: 'existing report',
  };
  saveState(state);
  return state;
}

describe('workflow persistence', () => {
  it('resolves WORKFLOW_FILE inside the configured state directory', () => {
    expect(WORKFLOW_FILE()).toBe(path.join(root, '.nightowl', 'nightowl.workflow.yaml'));
  });

  it('returns null for missing/empty workflow files', () => {
    expect(loadWorkflow()).toBeNull();
    fs.mkdirSync(path.dirname(WORKFLOW_FILE()), { recursive: true });
    fs.writeFileSync(WORKFLOW_FILE(), '');
    expect(loadWorkflow()).toBeNull();
  });

  it('atomically round-trips YAML, without creating pool or state files', () => {
    const source = workflow();
    source.name = '中文工作流';
    saveWorkflow(source);
    expect(loadWorkflow()).toEqual(source);
    expect(fs.existsSync(POOL_FILE())).toBe(false);
    expect(fs.existsSync(STATE_FILE())).toBe(false);
    expect(fs.readdirSync(path.dirname(WORKFLOW_FILE())).filter((f) => /\.lock|\.tmp/.test(f))).toEqual([]);
  });

  it('rejects invalid graphs before replacing a saved workflow', () => {
    saveWorkflow(workflow());
    const before = fs.readFileSync(WORKFLOW_FILE(), 'utf8');
    const invalid = workflow();
    invalid.stages[1].id = 'implement';
    expect(() => saveWorkflow(invalid)).toThrow('WORKFLOW_DUPLICATE_STAGE');
    expect(fs.readFileSync(WORKFLOW_FILE(), 'utf8')).toBe(before);
  });

  it('rejects invalid persisted data and invalid YAML', () => {
    fs.mkdirSync(path.dirname(WORKFLOW_FILE()), { recursive: true });
    fs.writeFileSync(WORKFLOW_FILE(), 'name: demo\nstages: nope\n');
    expect(() => loadWorkflow()).toThrow('WORKFLOW_INVALID');
    fs.writeFileSync(WORKFLOW_FILE(), 'stages: [');
    expect(() => loadWorkflow()).toThrow();
  });
});

describe('workflowToPool', () => {
  it('merges/deduplicates dependencies and gates, and maps agents to assignees', () => {
    const pool = workflowToPool(workflow());
    expect(pool.pool.map((t) => t.id)).toEqual(['CODE-A', 'CODE-B', 'REVIEW']);
    expect(pool.pool[0].verify).toEqual(['npm run typecheck']);
    expect(pool.pool[1].assignee).toBe('developer');
    expect(pool.pool[2]).toMatchObject({
      assignee: 'reviewer', depends_on: ['CODE-A', 'CODE-B'],
      verify: ['npm run lint', 'npm test'], description: 'Review code', acceptance: 'Tests pass',
    });
    expect(pool.schedule).toEqual({ retry_budget: 2 });
    expect(pool.checkpoint).toEqual({ enabled: true, write_every: 1 });
  });

  it('defaults omitted task status/dependencies without adding unnecessary verify fields', () => {
    const source: Workflow = { name: 'Minimal', stages: [{
      id: 'one', agent: 'dev', tasks: [{ id: 'A', title: 'Task A', priority: 'P2', est_min: 0 }],
    }] };
    expect(workflowToPool(source).pool).toEqual([task('A', { priority: 'P2', est_min: 0, assignee: 'dev' })]);
  });

  it('handles unordered stages, multiple prerequisites and transitive barriers', () => {
    const source: Workflow = { name: 'DAG', stages: [
      { id: 'final', agent: 'lead', depends_on: ['review'], tasks: [task('D')] },
      { id: 'review', agent: 'reviewer', depends_on: ['left', 'right'], tasks: [task('C')] },
      { id: 'left', agent: 'dev', tasks: [task('A')] },
      { id: 'right', agent: 'dev', tasks: [task('B')] },
    ] };
    const compiled = workflowToPool(source);
    expect(compiled.pool.find((t) => t.id === 'C')?.depends_on).toEqual(['A', 'B']);
    expect(compiled.pool.find((t) => t.id === 'D')?.depends_on).toEqual(['C']);
  });

  it('does not introduce dependencies between tasks in the same stage', () => {
    const compiled = workflowToPool(workflow());
    expect(compiled.pool[0].depends_on).toEqual([]);
    expect(compiled.pool[1].depends_on).toEqual([]);
  });

  it('preserves existing settings unless workflow settings explicitly override them', () => {
    const existing = seedPool();
    expect(workflowToPool(workflow(), existing)).toMatchObject({
      schedule: existing.schedule, checkpoint: existing.checkpoint,
    });
    const source = workflow();
    source.schedule = { retry_budget: 4 };
    source.checkpoint = { enabled: true, write_every: 2 };
    expect(workflowToPool(source, existing)).toMatchObject({
      schedule: source.schedule, checkpoint: source.checkpoint,
    });
  });

  it('does not mutate or share nested references with the input workflow/settings', () => {
    const source = workflow();
    const before = structuredClone(source);
    const defaults = seedPool();
    const compiled = workflowToPool(source, defaults);
    compiled.pool[0].depends_on.push('NEW');
    compiled.pool[0].verify?.push('NEW COMMAND');
    compiled.schedule.retry_budget = 100;
    compiled.checkpoint.enabled = true;
    expect(source).toEqual(before);
    expect(defaults.schedule.retry_budget).toBe(7);
    expect(defaults.checkpoint.enabled).toBe(false);
  });

  it('rejects duplicate stage IDs', () => {
    const source = workflow();
    source.stages[1].id = 'implement';
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_DUPLICATE_STAGE');
  });

  it.each(['same stage', 'different stages'])('rejects duplicate task IDs in %s', (where) => {
    const source = workflow();
    if (where === 'same stage') source.stages[0].tasks[1].id = 'CODE-A';
    else source.stages[1].tasks[0].id = 'CODE-A';
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_DUPLICATE_TASK');
  });

  it('rejects missing stage references', () => {
    const source = workflow();
    source.stages[1].depends_on = ['missing'];
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_UNKNOWN_STAGE');
  });

  it('rejects missing task references', () => {
    const source = workflow();
    source.stages[1].tasks[0].depends_on = ['missing'];
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_UNKNOWN_TASK');
  });

  it.each(['self', 'mutual'])('rejects %s stage cycles', (kind) => {
    const source = workflow();
    source.stages[0].depends_on = [kind === 'self' ? 'implement' : 'review'];
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_STAGE_CYCLE');
  });

  it.each(['self', 'same-stage', 'expanded'])('rejects %s task cycles', (kind) => {
    const source = workflow();
    source.stages[0].tasks[0].depends_on = [kind === 'self' ? 'CODE-A' : kind === 'same-stage' ? 'CODE-B' : 'REVIEW'];
    if (kind === 'same-stage') source.stages[0].tasks[1].depends_on = ['CODE-A'];
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_TASK_CYCLE');
  });

  it.each([
    ['missing name', (w: Workflow) => { w.name = ''; }],
    ['empty stages', (w: Workflow) => { w.stages = []; }],
    ['empty tasks', (w: Workflow) => { w.stages[0].tasks = []; }],
    ['empty agent', (w: Workflow) => { w.stages[0].agent = ''; }],
    ['empty command', (w: Workflow) => { w.stages[0].gate_commands = ['']; }],
    ['invalid priority', (w: Workflow) => { w.stages[0].tasks[0].priority = 'invalid'; }],
    ['invalid estimate', (w: Workflow) => { w.stages[0].tasks[0].est_min = -1; }],
    ['infinite estimate', (w: Workflow) => { w.stages[0].tasks[0].est_min = Infinity; }],
    ['invalid retry', (w: Workflow) => { w.schedule = { retry_budget: -1 }; }],
    ['invalid interval', (w: Workflow) => { w.checkpoint = { enabled: true, write_every: 0 }; }],
  ])('rejects malformed workflow: %s', (_, mutate) => {
    const source = workflow();
    mutate(source);
    expect(() => workflowToPool(source)).toThrow('WORKFLOW_INVALID');
  });

  it('rejects invalid task IDs before applying a pool', () => {
    const source = workflow();
    source.stages[0].tasks[0].id = '../escape';
    expect(() => workflowToPool(source)).toThrow('INVALID_TASK_ID');
  });
});

describe('nightowl workflow commands', () => {
  it('registers workflow with generate/list subcommands', () => {
    const registered = COMMAND_FACTORIES.map((create) => create()).find((c) => c.name() === 'workflow');
    expect(registered?.commands.map((c) => c.name())).toEqual(['generate', 'list']);
  });

  it.each([[], ['--apply']])('generate %j replaces the pool but preserves state bytes/settings', (...flags) => {
    const previous = seedPool();
    const state = seedState();
    const stateBefore = fs.readFileSync(STATE_FILE(), 'utf8');
    const result = runCommand(createWorkflowCommand(), ['generate', inputFile(), ...flags]);
    expect(result.exitCode).toBeUndefined();
    expect(loadWorkflow()).toEqual(workflow());
    expect(loadPool()?.pool.map((t) => t.id)).toEqual(['CODE-A', 'CODE-B', 'REVIEW']);
    expect(loadPool()?.schedule).toEqual(previous.schedule);
    expect(loadPool()?.checkpoint).toEqual(previous.checkpoint);
    expect(loadState()).toEqual(state);
    expect(fs.readFileSync(STATE_FILE(), 'utf8')).toBe(stateBefore);
  });

  it('generate --no-apply saves the workflow without changing pool/state bytes', () => {
    seedPool();
    seedState();
    const beforePool = fs.readFileSync(POOL_FILE(), 'utf8');
    const beforeState = fs.readFileSync(STATE_FILE(), 'utf8');
    const result = runCommand(createWorkflowCommand(), ['generate', inputFile(), '--no-apply']);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('--no-apply');
    expect(loadWorkflow()).toEqual(workflow());
    expect(fs.readFileSync(POOL_FILE(), 'utf8')).toBe(beforePool);
    expect(fs.readFileSync(STATE_FILE(), 'utf8')).toBe(beforeState);
  });

  it('generate --no-apply never reads an existing malformed task pool', () => {
    fs.mkdirSync(path.dirname(POOL_FILE()), { recursive: true });
    fs.writeFileSync(POOL_FILE(), 'pool: [');
    const result = runCommand(createWorkflowCommand(), ['generate', inputFile(), '--no-apply']);
    expect(result.exitCode).toBeUndefined();
    expect(fs.readFileSync(POOL_FILE(), 'utf8')).toBe('pool: [');
  });

  it.each([[], ['--no-apply']])('works without init and does not create independent state (%j)', (...flags) => {
    const result = runCommand(createWorkflowCommand(), ['generate', inputFile(), ...flags]);
    expect(result.exitCode).toBeUndefined();
    expect(fs.existsSync(WORKFLOW_FILE())).toBe(true);
    expect(fs.existsSync(POOL_FILE())).toBe(flags.length === 0);
    expect(fs.existsSync(STATE_FILE())).toBe(false);
  });

  it('can apply the saved workflow without an input argument', () => {
    saveWorkflow(workflow());
    const result = runCommand(createWorkflowCommand(), ['generate']);
    expect(result.exitCode).toBeUndefined();
    expect(loadPool()).toEqual(workflowToPool(workflow()));
  });

  it('list shows all stage agents, tasks and dependencies without modifying the pool', () => {
    saveWorkflow(workflow());
    const result = runCommand(createWorkflowCommand(), ['list']);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('implement\tImplementation\tdeveloper\tCODE-A, CODE-B\t-');
    expect(result.stdout).toContain('review\tReview\treviewer\tREVIEW\timplement');
    expect(fs.existsSync(POOL_FILE())).toBe(false);
  });

  it.each(['generate', 'list'])('%s fails clearly when no workflow exists', (subcommand) => {
    const result = runCommand(createWorkflowCommand(), [subcommand]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('WORKFLOW_NOT_FOUND');
  });

  it.each(['generate', 'list'])('%s fails clearly on an invalid saved graph', (subcommand) => {
    const invalid = workflow();
    invalid.stages[0].depends_on = ['review'];
    fs.mkdirSync(path.dirname(WORKFLOW_FILE()), { recursive: true });
    fs.writeFileSync(WORKFLOW_FILE(), yaml.dump(invalid));
    const result = runCommand(createWorkflowCommand(), [subcommand]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('WORKFLOW_STAGE_CYCLE');
    expect(fs.existsSync(POOL_FILE())).toBe(false);
  });

  it.each(['duplicate', 'cycle', 'yaml', 'shape', 'missing file'])('failed generate (%s) leaves all saved files unchanged', (kind) => {
    saveWorkflow(workflow());
    seedPool();
    seedState();
    const files = [WORKFLOW_FILE(), POOL_FILE(), STATE_FILE()];
    const before = files.map((file) => fs.readFileSync(file, 'utf8'));
    const invalid = workflow();
    if (kind === 'duplicate') invalid.stages[1].tasks[0].id = 'CODE-A';
    if (kind === 'cycle') invalid.stages[0].tasks[0].depends_on = ['REVIEW'];
    const file = inputFile(kind === 'shape' ? { stages: [] } : invalid);
    if (kind === 'yaml') fs.writeFileSync(file, 'stages: [');
    if (kind === 'missing file') fs.unlinkSync(file);
    const result = runCommand(createWorkflowCommand(), ['generate', file]);
    expect(result.exitCode).toBe(1);
    expect(files.map((saved) => fs.readFileSync(saved, 'utf8'))).toEqual(before);
  });

  it('uses localized English output and validation messages', () => {
    process.env.NIGHTOWL_LANG = 'en';
    const result = runCommand(createWorkflowCommand(), ['generate', inputFile()]);
    expect(result.stdout).toContain('Task pool replaced');
    const invalid = workflow();
    invalid.stages[1].id = 'implement';
    expect(() => workflowToPool(invalid)).toThrow('Duplicate stage ID');
  });

  it('the existing next scheduler respects compiled stage barriers', () => {
    const result = runCommand(createWorkflowCommand(), ['generate', inputFile()]);
    expect(result.exitCode).toBeUndefined();
    const next = runCommand(createNextCommand(), []);
    expect(next.exitCode).toBeUndefined();
    expect(loadState().in_progress?.id).toBe('CODE-A');
    expect(next.stdout).not.toContain('REVIEW\t');
    const state = loadState();
    state.in_progress = null;
    state.completed = ['CODE-A', 'CODE-B'].map((id) => ({ id, actual_min: 10, finished_at: '2026-10-19T00:00:00Z' }));
    saveState(state);
    const ready = runCommand(createNextCommand(), []);
    expect(ready.exitCode).toBeUndefined();
    expect(ready.stdout).toContain('REVIEW\t');
    expect(loadState().in_progress?.id).toBe('REVIEW');
  });
});


describe('intent/template workflow generation', () => {
  const prototypes = [
    ['feature', '新增登录功能', ['design', 'implement', 'verify', 'review'], ['architect', 'developer', 'tester', 'reviewer']],
    ['bugfix', '修复登录失败', ['diagnose', 'fix', 'regression', 'review'], ['debugger', 'developer', 'tester', 'reviewer']],
    ['refactor', '重构鉴权模块', ['baseline', 'refactor', 'regression', 'review'], ['tester', 'developer', 'tester', 'reviewer']],
    ['audit', '审计权限安全', ['inspect', 'review', 'report'], ['auditor', 'reviewer', 'auditor']],
  ] as const;

  it.each(prototypes)('infers %s with its own stages, roles and gates', (template, intent, stages, agents) => {
    seedPool();
    seedState();
    const stateBefore = fs.readFileSync(STATE_FILE(), 'utf8');
    const result = runCommand(createWorkflowCommand(), ['generate', '--intent', intent]);
    expect(result.exitCode).toBeUndefined();
    const generated = loadWorkflow()!;
    expect(generated.description).toBe(intent);
    expect(generated.stages.map((stage) => stage.id)).toEqual(stages);
    expect(generated.stages.map((stage) => stage.agent)).toEqual(agents);
    expect(result.stdout).toContain(template);
    const pool = loadPool()!;
    expect(pool.schedule.retry_budget).toBe(7);
    expect(pool.checkpoint).toEqual({ enabled: false, write_every: 3 });
    expect(pool.pool).toHaveLength(stages.length);
    generated.stages.forEach((stage, index) => {
      const gates: Record<string, string[]> = {
        design: ['git diff --check'], implement: ['npm run typecheck'], verify: ['npm test'],
        review: template === 'audit' ? ['npm run typecheck', 'npm test'] : ['git diff --check'],
        diagnose: ['git diff --check'], fix: ['npm run typecheck'], regression: ['npm test'],
        baseline: ['npm test'], refactor: ['npm run typecheck'], inspect: ['git diff --check'],
        report: ['git diff --check'],
      };
      expect(stage.gate_commands).toEqual(gates[stage.id]);
      expect(stage.tasks[0].description).toContain(intent);
      expect(stage.tasks[0].acceptance?.length).toBeGreaterThan(0);
      expect(pool.pool[index].verify).toEqual(stage.gate_commands);
      expect(pool.pool[index].assignee).toBe(agents[index]);
      expect(pool.pool[index].depends_on).toEqual(index ? [pool.pool[index - 1].id] : []);
    });
    expect(fs.readFileSync(STATE_FILE(), 'utf8')).toBe(stateBefore);
  });

  it.each([
    ['Fix a broken login', 'bugfix'], ['refactor the auth module', 'refactor'],
    ['security audit for auth', 'audit'], ['add an authentication feature', 'feature'],
    ['实现中文需求', 'feature'], ['audit a broken login before fixing', 'audit'],
    ['先修复缺陷再重构', 'bugfix'],
  ])('infers an English/Chinese intent: %s', (intent, template) => {
    const result = runCommand(createWorkflowCommand(), ['generate', '--intent', intent, '--no-apply']);
    expect(result.exitCode).toBeUndefined();
    expect(loadWorkflow()!.stages[0].tasks[0].id).toMatch(new RegExp(`^${template.toUpperCase()}-`));
    expect(fs.existsSync(POOL_FILE())).toBe(false);
    expect(fs.existsSync(STATE_FILE())).toBe(false);
  });

  it.each(['feature', 'bugfix', 'refactor', 'audit'])('allows explicit %s without intent', (template) => {
    const result = runCommand(createWorkflowCommand(), ['generate', '--template', template, '--no-apply']);
    expect(result.exitCode).toBeUndefined();
    expect(loadWorkflow()!.stages[0].tasks[0].id).toMatch(new RegExp(`^${template.toUpperCase()}-`));
  });

  it('explicit template wins over intent inference and preserves intent literally', () => {
    const intent = '修复问题; $(touch /tmp/never-run-nightowl-intent)';
    const result = runCommand(createWorkflowCommand(), ['generate', '--intent', intent, '--template', 'audit']);
    expect(result.exitCode).toBeUndefined();
    expect(loadWorkflow()!.description).toBe(intent);
    expect(loadWorkflow()!.stages[0].agent).toBe('auditor');
    expect(loadPool()!.pool.every((task) => !task.verify!.some((cmd) => cmd.includes(intent)))).toBe(true);
  });

  it.each([
    ['--intent', ''], ['--intent', '   '], ['--template', ''], ['--template', 'unknown'],
    ['--template', 'FEATURE'],
  ])('rejects invalid generation input %j without touching persisted files', (...args) => {
    saveWorkflow(workflow()); seedPool(); seedState();
    const files = [WORKFLOW_FILE(), POOL_FILE(), STATE_FILE()];
    const before = files.map((file) => fs.readFileSync(file, 'utf8'));
    const result = runCommand(createWorkflowCommand(), ['generate', ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('WORKFLOW_');
    expect(files.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it.each([['--intent', '修复问题'], ['--template', 'feature'], ['--intent', '新增功能', '--template', 'feature']])(
    'rejects file combined with generation options %j before reading the file', (...args) => {
      const result = runCommand(createWorkflowCommand(), ['generate', path.join(root, 'missing.yaml'), ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('WORKFLOW_SOURCE_CONFLICT');
      expect(fs.existsSync(WORKFLOW_FILE())).toBe(false);
      expect(fs.existsSync(POOL_FILE())).toBe(false);
    },
  );

  it('generates fresh deterministic scaffolds without leaking edits across invocations', () => {
    const first = createWorkflowFromIntent('新增功能');
    const second = createWorkflowFromIntent('新增功能');
    expect(second).toEqual(first);
    first.stages[0].gate_commands!.push('custom check');
    first.stages[1].depends_on!.push('custom stage');
    first.stages[0].tasks[0].title = 'edited';
    expect(createWorkflowFromIntent('新增功能')).toEqual(second);
  });

  it('intent --no-apply ignores a malformed pool and preserves execution state', () => {
    saveWorkflow(workflow());
    seedPool();
    seedState();
    fs.writeFileSync(POOL_FILE(), 'pool: [');
    const before = fs.readFileSync(STATE_FILE(), 'utf8');
    const result = runCommand(createWorkflowCommand(), ['generate', '--intent', '重构模块', '--no-apply']);
    expect(result.exitCode).toBeUndefined();
    expect(loadWorkflow()!.stages[0].id).toBe('baseline');
    expect(fs.readFileSync(POOL_FILE(), 'utf8')).toBe('pool: [');
    expect(fs.readFileSync(STATE_FILE(), 'utf8')).toBe(before);
  });

  it('invalid existing pool prevents intent generation from replacing the saved workflow', () => {
    saveWorkflow(workflow());
    seedPool();
    fs.writeFileSync(POOL_FILE(), 'pool: [');
    const before = fs.readFileSync(WORKFLOW_FILE(), 'utf8');
    const result = runCommand(createWorkflowCommand(), ['generate', '--intent', '新增功能']);
    expect(result.exitCode).toBe(1);
    expect(fs.readFileSync(WORKFLOW_FILE(), 'utf8')).toBe(before);
    expect(fs.readFileSync(POOL_FILE(), 'utf8')).toBe('pool: [');
  });

  it('localizes generated stages, titles, help and errors in English', () => {
    process.env.NIGHTOWL_LANG = 'en';
    const result = runCommand(createWorkflowCommand(), ['generate', '--intent', 'fix a bug']);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('bugfix');
    expect(loadWorkflow()!.stages[0].name).toBe('Diagnosis');
    expect(loadWorkflow()!.stages[0].tasks[0].title).toContain('Diagnose');
    const failed = runCommand(createWorkflowCommand(), ['generate', '--template', 'nope']);
    expect(failed.stderr).toContain('Unknown workflow template');
    expect(createWorkflowCommand().commands[0].helpInformation()).toContain('--intent');
  });
});
