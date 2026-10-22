import { randomUUID } from 'node:crypto';
import { updatePool, type Task, type VerifyPassed } from './state.js';
import { isoNow } from './util.js';

export type EvidenceStatus = 'valid' | 'missing' | 'invalid';
const sameCommands = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Missing legacy evidence is not a failure, but is never proof of current validity. */
export function verificationEvidence(task: Task): EvidenceStatus {
  const run = task.verification_run;
  const receipt = task.verify_passed;
  if (run && (run.status !== 'passed' || !sameCommands(run.commands, task.verify ?? []))) return 'invalid';
  if (receipt && !sameCommands(receipt.commands, task.verify ?? [])) return 'invalid';
  if (!task.verify?.length || !run || !receipt || !receipt.run_id) return 'missing';
  return receipt.run_id === run.id ? 'valid' : 'invalid';
}

export function reviewEvidence(task: Task): EvidenceStatus {
  const review = task.review;
  if (!review) return 'missing';
  if (review.result !== 'PASS' && review.result !== 'PASS_WITH_NITS') return 'invalid';
  if (!task.verify?.length && !task.verification_run) return 'valid';
  if (!review.verify_run_id) return 'missing';
  if (verificationEvidence(task) !== 'valid') return 'invalid';
  return review.verify_run_id === task.verification_run?.id ? 'valid' : 'invalid';
}

/** Begin under the store lock before executing any command, including a crashing/long-running one. */
export function beginVerification(taskId: string, commands: string[]): string | null {
  const id = randomUUID();
  return updatePool((pool) => {
    const task = pool.pool.find((item) => item.id === taskId);
    if (!task || !sameCommands(task.verify ?? [], commands)) return false;
    task.verification_run = { id, status: 'running', at: isoNow(), commands: [...commands] };
    delete task.verify_passed;
  }) ? id : null;
}

/** Compare-and-set: an older process cannot publish over a newer verification. */
export function finishVerification(
  taskId: string,
  runId: string,
  receipt?: VerifyPassed,
  onCurrent?: () => void,
): boolean {
  let commandsMatch = true;
  const applied = updatePool((pool) => {
    const task = pool.pool.find((item) => item.id === taskId);
    const run = task?.verification_run;
    if (!task || !run || run.id !== runId || run.status !== 'running') return false;
    if (!sameCommands(run.commands, task.verify ?? []) || (receipt && !sameCommands(receipt.commands, run.commands))) {
      commandsMatch = false;
      run.status = 'failed';
      run.at = isoNow();
      delete task.verify_passed;
      return;
    }
    onCurrent?.();
    run.status = receipt ? 'passed' : 'failed';
    run.at = isoNow();
    if (receipt) task.verify_passed = { ...receipt, run_id: runId };
    else delete task.verify_passed;
  });
  return applied && commandsMatch;
}

/** A failing merge-time integration check also revokes its source verification. */
export function failIntegrationEvidence(taskId: string, runId: string | undefined): void {
  updatePool((pool) => {
    const task = pool.pool.find((item) => item.id === taskId);
    if (!task || task.verification_run?.id !== runId) return false;
    delete task.verify_passed;
    if (task.verification_run) {
      task.verification_run.status = 'failed';
      task.verification_run.at = isoNow();
    }
  });
}
