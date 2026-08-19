import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { pkgRoot, TASKS_DIR } from '../paths.js';
import { loadPool, savePool, log, type Task } from '../state.js';
import { slugify, datePrefix, safeSegment } from '../util.js';
import { getIdentity, DEFAULT_IDENTITY } from '../identity.js';
import { t } from '../i18n.js';

export interface AddOptions {
  id: string;
  title: string;
  priority: string;
  estMin: number;
  assignee?: string;
  desc?: string;
  acceptance?: string;
  dependsOn?: string[];
  verify?: string[];
  slug?: string;
}

/** 为任务生成 PRD 文档,返回 .nightowl 相对路径;模板缺失时返回 null。 */
export function renderPrd(args: AddOptions, task: Task): string | null {
  const tmplPath = path.join(pkgRoot(), 'templates', 'prd.md.tmpl');
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, 'utf8');
  } catch {
    return null;
  }
  // slug 策略:显式 --slug > ASCII title > 任务 id(中文 title 无法转 ASCII slug)
  let rawSlug: string;
  if (args.slug) rawSlug = args.slug;
  else if (/^[\x00-\x7F]*$/.test(args.title)) rawSlug = args.title;
  else rawSlug = args.id;
  const slug = slugify(rawSlug) || slugify(args.id);
  const prefix = datePrefix();
  const assigneeDir = safeSegment(task.assignee ?? '') || DEFAULT_IDENTITY;
  let taskDir = path.join(TASKS_DIR(), assigneeDir, `${prefix}-${slug}`);
  let n = 2;
  while (fs.existsSync(taskDir)) {
    taskDir = path.join(TASKS_DIR(), assigneeDir, `${prefix}-${slug}-${n}`);
    n += 1;
  }
  fs.mkdirSync(taskDir, { recursive: true });

  const verifyBullets = (args.verify ?? []).map((v) => `- [ ] \`${v}\``).join('\n');
  const acceptanceLines = (args.acceptance ?? '')
    .split(';')
    .map((l) => l.trim())
    .filter(Boolean);
  let acceptanceBullets = acceptanceLines.map((l) => `- [ ] ${l}`).join('\n');
  if (!acceptanceBullets && args.acceptance) {
    acceptanceBullets = `- [ ] ${args.acceptance}`;
  }

  const body = tmpl
    .replace(/\$\{title\}/g, args.title)
    .replace(/\$\{description\}/g, args.desc || t('add.taskGoal'))
    .replace(/\$\{acceptance\}/g, acceptanceBullets)
    .replace(/\$\{verify\}/g, verifyBullets);

  fs.writeFileSync(path.join(taskDir, 'prd.md'), body, 'utf8');
  return path.join('.nightowl', 'tasks', assigneeDir, path.basename(taskDir), 'prd.md');
}

export function createAddCommand(): Command {
  return new Command('add')
    .description(t('add.desc'))
    .requiredOption('--id <id>')
    .requiredOption('--title <title>')
    .option('--priority <priority>', 'P0/P1/P2', 'P2')
    .requiredOption('--est-min <min>', t('add.estMinOption'), (v: string) => parseInt(v, 10))
    .option('--assignee <name>', t('add.assigneeOption'))
    .option('--desc <desc>', t('add.descOption'))
    .option('--acceptance <acceptance>', t('add.acceptanceOption'))
    .option('--depends-on <id>', t('add.dependsOnOption'), (v: string, acc: string[]) => acc.concat(v), [] as string[])
    .option('--verify <cmd>', t('add.verifyOption'), (v: string, acc: string[]) => acc.concat(v), [] as string[])
    .option('--slug <slug>', t('add.slugOption'))
    .action((args: AddOptions) => {
      const pool = loadPool();
      if (!pool) {
        console.error(t('common.noPool'));
        process.exit(1);
      }
      if (pool.pool.some((t) => t.id === args.id)) {
        console.error(t('add.taskExists', { id: args.id }));
        process.exit(1);
      }
      const assignee = args.assignee ?? getIdentity();
      const task: Task = {
        id: args.id,
        title: args.title,
        priority: args.priority.toUpperCase(),
        est_min: args.estMin,
        depends_on: args.dependsOn ?? [],
        status: 'pending',
        assignee,
      };
      if (args.desc) task.description = args.desc;
      if (args.acceptance) task.acceptance = args.acceptance;
      if (args.verify?.length) task.verify = args.verify;
      const prdPath = renderPrd(args, task);
      if (prdPath) task.prd_path = prdPath;
      pool.pool.push(task);
      savePool(pool);
      log(t('add.added', { id: args.id, prio: task.priority, title: args.title, est: task.est_min, assignee }));
      console.log(t('add.ok'));
    });
}
