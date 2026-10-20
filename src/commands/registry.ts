import type { Command } from 'commander';
import { createInitCommand } from './init.js';
import { createAddCommand } from './add.js';
import { createStatusCommand } from './status.js';
import { createNextCommand } from './next.js';
import { createDoneCommand } from './done.js';
import { createBlockCommand } from './block.js';
import { createVerifyCommand } from './verify.js';
import { createAnalyzeCommand } from './analyze.js';
import { createReviewCommand } from './review.js';
import { createSweepCommand } from './sweep.js';
import { createPushCommand } from './push.js';
import { createReportCommand } from './report.js';
import { createCheckpointCommand } from './checkpoint.js';
import { createSelfcheckCommand } from './selfcheck.js';
import { createSuperviseCommand } from './supervise.js';
import { createWorktreeCommand } from './worktree.js';
import { createWorkflowCommand } from './workflow.js';

export type CommandFactory = () => Command;

/** 命令工厂单一来源:cli.ts 按序注册,skills.test.ts 校验文档引用与真实命令一致。 */
export const COMMAND_FACTORIES: CommandFactory[] = [
  createInitCommand,
  createAddCommand,
  createStatusCommand,
  createNextCommand,
  createDoneCommand,
  createBlockCommand,
  createVerifyCommand,
  createAnalyzeCommand,
  createReviewCommand,
  createSweepCommand,
  createPushCommand,
  createReportCommand,
  createCheckpointCommand,
  createSelfcheckCommand,
  createSuperviseCommand,
  createWorktreeCommand,
  createWorkflowCommand,
];
