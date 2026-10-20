import { Command } from 'commander';
import fs from 'node:fs';
import { CONTEXT_FILE } from '../paths.js';
import { log } from '../state.js';
import { t } from '../i18n.js';

/** 从 JSON 依赖清单里取 scripts/构建命令(形如 `test: vitest run`)。
 *  解析失败返回 null(交回逐行扫描兜底),不因一个坏文件让 analyze 崩掉。 */
function extractJsonScripts(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const out: string[] = [];
  // 只取与"怎么跑测试/构建"相关的字段,避免把整个依赖树塞进上下文
  for (const key of ['scripts']) {
    const sec = obj[key];
    if (typeof sec !== 'object' || sec === null) continue;
    for (const [name, cmd] of Object.entries(sec as Record<string, unknown>)) {
      if (typeof cmd !== 'string') continue;
      if (['test', 'build', 'lint', 'check', 'typecheck'].some((k) => name.toLowerCase().includes(k))) {
        out.push(`${name}: ${cmd}`);
      }
    }
  }
  if (!out.length) {
    // 没有 scripts 段时至少把技术栈线索留下(依赖名)
    const deps = { ...(obj.dependencies as object), ...(obj.devDependencies as object) };
    const names = Object.keys(deps ?? {});
    if (names.length) out.push(`deps: ${names.slice(0, 20).join(', ')}`);
  }
  return out;
}

const DOC_KEYWORDS = ['README', 'readme', 'README.md', 'README.txt'];
const BUILD_FILES = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'setup.py',
];
const CI_FILES = ['.gitlab-ci.yml', 'Jenkinsfile', '.circleci', 'azure-pipelines.yml'];
const KEY_DIRS = ['src', 'tests', 'lib', 'app'];

export function createAnalyzeCommand(): Command {
  return new Command('analyze')
    .description(t('analyze.desc'))
    .action(() => {
      const ctx: string[] = [];

      // 1. 构建/依赖文件 → 技术栈 + 测试/构建命令
      const buildFiles: string[] = [];
      for (const f of BUILD_FILES) {
        if (!fs.existsSync(f)) continue;
        buildFiles.push(f);
        const text = fs.readFileSync(f, 'utf8');
        // JSON 依赖清单(package.json 等)整行都以 `"` 开头,逐行扫描会被前缀过滤全部跳过,
        // 必须先按 JSON 解析取 scripts;非 JSON 的清单(Toml/gomod/requirements)才逐行扫。
        const jsonScripts = f.endsWith('.json') ? extractJsonScripts(text) : null;
        if (jsonScripts) {
          ctx.push(...jsonScripts.map((line) => `    ${line}`));
          continue;
        }
        for (const raw of text.slice(0, 1200).split('\n')) {
          const s = raw.trim();
          if (!s || /^(#|\/\/|\[)/.test(s)) continue;
          if (['test', 'script', 'build'].some((k) => s.toLowerCase().includes(k))) {
            ctx.push(`    ${s}`);
          }
        }
      }
      if (buildFiles.length) ctx.unshift(t('analyze.buildDeps', { files: buildFiles.join(', ') }));

      // 2. README 前几句
      for (const f of DOC_KEYWORDS) {
        if (!fs.existsSync(f)) continue;
        const head = fs
          .readFileSync(f, 'utf8')
          .slice(0, 1000)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 6);
        if (head.length) {
          ctx.push(t('analyze.readmeSummary'));
          ctx.push(...head.map((l) => `    ${l}`));
        }
        break;
      }

      // 3. CI 配置
      if (fs.existsSync('.github/workflows')) {
        const wfs = fs
          .readdirSync('.github/workflows')
          .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
          .sort();
        for (const wf of wfs) {
          const body = fs
            .readFileSync(`.github/workflows/${wf}`, 'utf8')
            .slice(0, 250)
            .split(/\s+/)
            .join(' ');
          ctx.push(t('analyze.ciWorkflow', { wf, body: body.slice(0, 150) }));
        }
      }
      for (const ci of CI_FILES) {
        if (fs.existsSync(ci)) ctx.push(t('analyze.ciFile', { ci }));
      }

      // 4. 关键目录
      for (const d of KEY_DIRS) {
        if (!fs.existsSync(d)) continue;
        const files = fs.readdirSync(d).slice(0, 10);
        ctx.push(`- ${d}/: ${files.join(', ')}`);
      }

      console.log(t('analyze.title'));
      console.log('─'.repeat(60));
      console.log(t('analyze.contextTitle'));
      for (const line of ctx) console.log(line);
      console.log('─'.repeat(60));
      log(t('analyze.contextLog', { ctx: ctx.join(' ').slice(0, 400) }));
      const contextFile = CONTEXT_FILE();
      fs.writeFileSync(
        contextFile,
        t('analyze.contextTitle') + '\n' + ctx.map((l) => `  ${l}`).join('\n') + '\n',
        'utf8',
      );
      console.log(t('analyze.written', { file: contextFile }));
    });
}
