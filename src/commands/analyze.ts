import { Command } from 'commander';
import fs from 'node:fs';
import { CONTEXT_FILE } from '../paths.js';
import { log } from '../state.js';
import { t } from '../i18n.js';

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
        for (const raw of text.slice(0, 1200).split('\n')) {
          const s = raw.trim();
          if (!s || /^(#|\/\/|"|'|\[)/.test(s)) continue;
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
