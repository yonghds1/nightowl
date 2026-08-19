import { Command } from 'commander';
import { COMMAND_FACTORIES } from './commands/registry.js';
import { getPkgVersion } from './paths.js';
import { t } from './i18n.js';

const program = new Command();

// 命令列表单一来源在 commands/registry.ts;版本取 paths.getPkgVersion
// (懒读 package.json,与 status 自检共用单一来源)
program
  .name('nightowl')
  .description(t('cli.description'))
  .version(getPkgVersion())
  .option('--dir <dir>', t('cli.dirOption'), '.');
for (const create of COMMAND_FACTORIES) program.addCommand(create());

// --dir 是全局选项,需在子命令 action 执行前 chdir,
// 让 .nightowl/ 与 git 操作都相对项目根。
program.hook('preAction', (thisCommand) => {
  const dir = thisCommand.opts().dir ?? '.';
  if (dir !== '.') process.chdir(dir);
});

program.parse(process.argv);
