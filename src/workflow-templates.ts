import { t } from './i18n.js';
import type { Workflow } from './state.js';

export const WORKFLOW_TEMPLATES = ['feature', 'bugfix', 'refactor', 'audit'] as const;
export type WorkflowTemplate = typeof WORKFLOW_TEMPLATES[number];

type StagePrototype = { id: string; agent: string; gates: readonly string[] };
const DIFF_GATE = ['git diff --check'];
const TYPE_GATE = ['npm run typecheck'];
const TEST_GATE = ['npm test'];
const PROTOTYPES: Record<WorkflowTemplate, readonly StagePrototype[]> = {
  feature: [
    { id: 'design', agent: 'architect', gates: DIFF_GATE },
    { id: 'implement', agent: 'developer', gates: TYPE_GATE },
    { id: 'verify', agent: 'tester', gates: TEST_GATE },
    { id: 'review', agent: 'reviewer', gates: DIFF_GATE },
  ],
  bugfix: [
    { id: 'diagnose', agent: 'debugger', gates: DIFF_GATE },
    { id: 'fix', agent: 'developer', gates: TYPE_GATE },
    { id: 'regression', agent: 'tester', gates: TEST_GATE },
    { id: 'review', agent: 'reviewer', gates: DIFF_GATE },
  ],
  refactor: [
    { id: 'baseline', agent: 'tester', gates: TEST_GATE },
    { id: 'refactor', agent: 'developer', gates: TYPE_GATE },
    { id: 'regression', agent: 'tester', gates: TEST_GATE },
    { id: 'review', agent: 'reviewer', gates: DIFF_GATE },
  ],
  audit: [
    { id: 'inspect', agent: 'auditor', gates: DIFF_GATE },
    { id: 'review', agent: 'reviewer', gates: [...TYPE_GATE, ...TEST_GATE] },
    { id: 'report', agent: 'auditor', gates: DIFF_GATE },
  ],
};

/** Deterministic intent routing; an explicit template always takes precedence. */
export function resolveWorkflowTemplate(intent?: string, template?: string): WorkflowTemplate {
  if (intent !== undefined && !intent.trim()) throw new Error(t('workflow.emptyIntent'));
  if (template !== undefined) {
    const selected = WORKFLOW_TEMPLATES.find((name) => name === template);
    if (!selected) {
      throw new Error(t('workflow.unknownTemplate', { template, choices: WORKFLOW_TEMPLATES.join(', ') }));
    }
    return selected;
  }
  const text = intent ?? '';
  if (/审计|审查|审核|安全检查|\b(?:audit|review|inspect|security)\b/i.test(text)) return 'audit';
  if (/修复|修正|排错|排查|故障|缺陷|\b(?:bugfix|bug|fix|debug|broken|crash)\b/i.test(text)) return 'bugfix';
  if (/重构|重整|\b(?:refactor|refactoring|restructure)\b/i.test(text)) return 'refactor';
  return 'feature';
}

/** Build declarative stages only: all graph expansion remains in workflowToPool. */
export function createWorkflowFromIntent(intent?: string, template?: string): Workflow {
  const selected = resolveWorkflowTemplate(intent, template);
  const prototypes = PROTOTYPES[selected];
  const name = t(`workflow.templates.${selected}`);
  const description = intent ?? name;
  return {
    name: intent === undefined ? name : `${name}: ${intent}`,
    description,
    stages: prototypes.map((stage, index) => ({
      id: stage.id,
      name: t(`workflow.stageNames.${stage.id}`),
      agent: stage.agent,
      depends_on: index ? [prototypes[index - 1].id] : [],
      gate_commands: [...stage.gates],
      tasks: [{
        id: `${selected.toUpperCase()}-${stage.id.toUpperCase()}`,
        title: `${t(`workflow.stageTasks.${stage.id}`)}: ${description}`,
        priority: 'P1',
        est_min: 30,
        description: t(`workflow.stageDescriptions.${stage.id}`, { intent: description }),
        acceptance: t(`workflow.stageAcceptance.${stage.id}`),
      }],
    })),
  };
}
