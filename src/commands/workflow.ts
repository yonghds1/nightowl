import { Command } from 'commander';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { WORKFLOW_FILE, POOL_FILE } from '../paths.js';
import { loadPool, loadWorkflow, savePool, saveWorkflow, workflowToPool, type Workflow } from '../state.js';
import { t } from '../i18n.js';
import { createWorkflowFromIntent, resolveWorkflowTemplate } from '../workflow-templates.js';

function runWorkflowAction(action: () => void): void {
  try {
    action();
  } catch (error: unknown) {
    console.error(t('workflow.failed', { error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}

function requireWorkflow(): Workflow {
  const workflow = loadWorkflow();
  if (!workflow) throw new Error(t('workflow.noWorkflow', { file: WORKFLOW_FILE() }));
  return workflow;
}

export function createWorkflowCommand(): Command {
  const command = new Command('workflow').description(t('workflow.desc'));

  command.command('generate')
    .description(t('workflow.generateDesc'))
    .argument('[file]', t('workflow.fileArgument'))
    .option('--intent <text>', t('workflow.intentOption'))
    .option('--template <name>', t('workflow.templateOption'))
    .option('--apply', t('workflow.applyOption'), true)
    .option('--no-apply', t('workflow.noApplyOption'))
    .action((file: string | undefined, opts: { apply: boolean; intent?: string; template?: string }) => {
      runWorkflowAction(() => {
        const fromIntent = opts.intent !== undefined || opts.template !== undefined;
        if (file !== undefined && fromIntent) throw new Error(t('workflow.sourceConflict'));
        // workflowToPool validates the unknown YAML before either output is touched.
        const workflow = file
          ? yaml.load(fs.readFileSync(file, 'utf8')) as Workflow
          : fromIntent ? createWorkflowFromIntent(opts.intent, opts.template) : requireWorkflow();
        const pool = workflowToPool(workflow, opts.apply ? loadPool() : null);
        saveWorkflow(workflow);
        if (opts.apply) savePool(pool);
        if (fromIntent) console.log(t('workflow.selectedTemplate', {
          template: resolveWorkflowTemplate(opts.intent, opts.template),
        }));
        console.log(t('workflow.generated', {
          name: workflow.name, stages: workflow.stages.length, tasks: pool.pool.length, file: WORKFLOW_FILE(),
        }));
        console.log(opts.apply
          ? t('workflow.applied', { file: POOL_FILE() })
          : t('workflow.notApplied'));
      });
    });

  command.command('show')
    .description(t('workflow.showDesc'))
    .action(() => runWorkflowAction(() => {
      console.log(yaml.dump(requireWorkflow(), { noRefs: true }).trimEnd());
    }));

  command.command('list')
    .description(t('workflow.listDesc'))
    .action(() => runWorkflowAction(() => {
      const workflow = requireWorkflow();
      console.log(t('workflow.listTitle', { name: workflow.name }));
      console.log(t('workflow.listHeader'));
      for (const stage of workflow.stages) {
        console.log([
          stage.id, stage.name ?? stage.id, stage.agent,
          stage.tasks.map((task) => task.id).join(', '),
          (stage.depends_on ?? []).join(', ') || '-',
        ].join('\t'));
      }
    }));

  return command;
}
