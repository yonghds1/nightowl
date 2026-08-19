import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { pkgRoot } from '../src/paths.js';
import { COMMAND_FACTORIES } from '../src/commands/registry.js';

const DOC_FILES = [
  'skills/nightowl-plan/SKILL.md',
  'skills/nightowl-run/SKILL.md',
  'skills/nightowl-report/SKILL.md',
];

// 宿主(Claude/Codex)的启动参数,不是 nightowl 选项;出现在技能提示文案里,单独校验"仍在文档中"
const HOST_FLAGS = ['--dangerously-skip-permissions', '--full-auto'];

function rootCommands(): Command[] {
  const root = new Command('nightowl');
  for (const create of COMMAND_FACTORIES) root.addCommand(create());
  const out: Command[] = [];
  const walk = (c: Command): void => {
    out.push(c);
    c.commands.forEach(walk);
  };
  root.commands.forEach(walk);
  return out;
}

function realCommandNames(): Set<string> {
  return new Set(rootCommands().map((c) => c.name()));
}

function realOptionLongs(): Set<string> {
  const s = new Set<string>(['--dir', '--help']);
  for (const c of rootCommands()) for (const o of c.options) if (o.long) s.add(o.long);
  return s;
}

function docText(): string {
  return DOC_FILES.map((f) => fs.readFileSync(path.join(pkgRoot(), f), 'utf8')).join('\n');
}

function collectCommands(text: string): Set<string> {
  const s = new Set<string>();
  // `nightowl <cmd>` 以及 `nightowl --dir <根> <cmd>` 两种写法
  for (const m of text.matchAll(/nightowl\s+([a-z][a-z-]*)/g)) s.add(m[1]);
  for (const m of text.matchAll(/--dir\s+<[^>]+>\s+([a-z][a-z-]*)/g)) s.add(m[1]);
  return s;
}

/** 只从 `nightowl` 调用处抽选项(含 `\` 续行),避免抓到 git/claude/codex 等外部命令的参数。 */
function collectNightowlOptions(text: string): Set<string> {
  const s = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf('nightowl');
    if (idx < 0) continue;
    let block = lines[i].slice(idx);
    while (block.trimEnd().endsWith('\\')) {
      block = block.replace(/\\\s*$/, ' ') + lines[++i];
    }
    for (const m of block.matchAll(/--[a-z][a-z-]+/g)) s.add(m[0]);
  }
  return s;
}

describe('SKILL frontmatter 结构', () => {
  for (const d of ['plan', 'run', 'report']) {
    it(`${d}: name/description 齐全,description 不过长`, () => {
      const lines = fs
        .readFileSync(path.join(pkgRoot(), 'skills', `nightowl-${d}`, 'SKILL.md'), 'utf8')
        .split('\n');
      expect(lines[0]).toBe('---');
      expect(lines[1]).toBe(`name: nightowl-${d}`);
      expect(lines[3]).toBe('---');
      expect(lines[2].startsWith('description: ')).toBe(true);
      const desc = lines[2].slice('description: '.length);
      expect(desc.length).toBeGreaterThan(0);
      // 过长会在技能列表折行看不全(2026-08-12 实战反馈)
      expect(Array.from(desc).length).toBeLessThanOrEqual(100);
    });
  }
});

describe('SKILL/模板命令引用 ⊆ 真实 CLI 命令', () => {
  const real = realCommandNames();

  for (const f of DOC_FILES) {
    it(`引用命令都在 cli.ts 注册: ${f}`, () => {
      const text = fs.readFileSync(path.join(pkgRoot(), f), 'utf8');
      for (const cmd of collectCommands(text)) {
        expect(real.has(cmd), `${f} 引用不存在的命令: nightowl ${cmd}`).toBe(true);
      }
    });
  }

  it('核心命令都有文档引用(防文档被删空)', () => {
    const cited = collectCommands(docText());
    for (const core of ['init', 'add', 'status', 'next', 'done', 'report']) {
      expect(cited.has(core), `文档未引用核心命令 nightowl ${core}`).toBe(true);
    }
  });
});

describe('SKILL/模板选项引用 ⊆ 真实 CLI 选项', () => {
  const real = realOptionLongs();

  for (const f of DOC_FILES) {
    it(`引用选项都在 CLI 定义里: ${f}`, () => {
      const text = fs.readFileSync(path.join(pkgRoot(), f), 'utf8');
      for (const opt of collectNightowlOptions(text)) {
        if (HOST_FLAGS.includes(opt)) continue;
        expect(real.has(opt), `${f} 引用不存在的选项: ${opt}`).toBe(true);
      }
    });
  }

  it('run 提示文案保留两平台无交互启动参数', () => {
    const text = docText();
    for (const flag of HOST_FLAGS) expect(text, `文档缺少宿主启动参数 ${flag}`).toContain(flag);
  });
});

describe('run SKILL 关键约束不丢(安全阀)', () => {
  const text = fs.readFileSync(path.join(pkgRoot(), 'skills', 'nightowl-run', 'SKILL.md'), 'utf8');

  it.each([
    ['selfcheck', '开工前自检权限模式'],
    ['bypass', '静默依赖 bypass 权限'],
    ['worktree remove', 'worktree 用完即删'],
    ['不向用户提问', '静默契约:run 不提问'],
    ['verify', '测试关口(verify 是完成标准)'],
  ])('保留 %s: %s', (kw) => {
    expect(text, `run SKILL 缺少关键约束: ${kw}`).toContain(kw);
  });
});

describe('plan/report SKILL 关键流程不丢', () => {
  it.each(['plan', 'report'])('%s SKILL 可读', (d) => {
    const text = fs.readFileSync(path.join(pkgRoot(), 'skills', `nightowl-${d}`, 'SKILL.md'), 'utf8');
    expect(text.length).toBeGreaterThan(100);
  });
});
