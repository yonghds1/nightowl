import fs from 'node:fs';
import yaml from 'js-yaml';
import {
  POOL_FILE,
  STATE_FILE,
  LOG_FILE,
  CHECKPOINT_FILE,
  CHECKPOINT_BACKUP,
  ensureBaseDir,
} from './paths.js';
import { fmtDateTime, isoNow } from './util.js';

export interface Review {
  result: string;
  level: string;
  note: string;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  priority: string;
  est_min: number;
  depends_on: string[];
  status: string;
  assignee?: string;
  description?: string;
  acceptance?: string;
  verify?: string[];
  prd_path?: string;
  actual_min?: number;
  verify_passed?: { at: string; commands: string[] };
  review?: Review;
  review_history?: Review[];
}

export interface Pool {
  schedule: {
    retry_budget: number;
  };
  checkpoint: { enabled: boolean; write_every: number };
  pool: Task[];
}

export interface CompletedEntry {
  id: string;
  actual_min: number;
  finished_at: string;
}

export interface BlockedEntry {
  id: string;
  reason: string;
  blocked_at: string;
}

export interface AppState {
  completed: CompletedEntry[];
  blocked: BlockedEntry[];
  in_progress: { id: string; started_at: string } | null;
  last_run?: string | null;
  report?: string | null;
}

export interface Checkpoint {
  version: number;
  updated_at: string;
  pool: Pool;
  state: AppState;
  stats?: { total: number; completed: number };
}

function atomicWrite(f: string, content: string): void {
  ensureBaseDir();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, f);
}

export function loadPool(): Pool | null {
  const f = POOL_FILE();
  if (!fs.existsSync(f)) return null;
  const data = yaml.load(fs.readFileSync(f, 'utf8')) as Pool | null;
  return data ?? null;
}

export function loadState(): AppState {
  const f = STATE_FILE();
  if (!fs.existsSync(f)) return { completed: [], blocked: [], in_progress: null };
  const data = yaml.load(fs.readFileSync(f, 'utf8')) as AppState | null;
  return data ?? { completed: [], blocked: [], in_progress: null };
}

export function savePool(pool: Pool): void {
  atomicWrite(POOL_FILE(), yaml.dump(pool, { noRefs: true }));
}

export function saveState(state: AppState): void {
  atomicWrite(STATE_FILE(), yaml.dump(state, { noRefs: true }));
}

export function log(msg: string): void {
  ensureBaseDir();
  const line = `[${fmtDateTime()}] ${msg}`;
  fs.appendFileSync(LOG_FILE(), `${line}\n`, 'utf8');
  console.log(line);
}

export function saveCheckpoint(
  pool: Pool,
  state: AppState,
  stats?: { total: number; completed: number },
): void {
  ensureBaseDir();
  // 双轮切换:当前文件 → backup,始终留一份完整数据
  if (fs.existsSync(CHECKPOINT_FILE())) {
    fs.renameSync(CHECKPOINT_FILE(), CHECKPOINT_BACKUP());
  }
  const cp: Checkpoint = {
    version: 1,
    updated_at: isoNow(),
    pool,
    state,
    ...(stats ? { stats } : {}),
  };
  atomicWrite(CHECKPOINT_FILE(), yaml.dump(cp, { noRefs: true }));
}

export function loadCheckpoint(): Checkpoint | null {
  for (const f of [CHECKPOINT_FILE(), CHECKPOINT_BACKUP()]) {
    if (fs.existsSync(f)) {
      try {
        const data = yaml.load(fs.readFileSync(f, 'utf8')) as Checkpoint | null;
        if (data) return data;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function clearCheckpoint(): void {
  for (const f of [CHECKPOINT_FILE(), CHECKPOINT_BACKUP()]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

export function shouldCheckpoint(state: AppState, interval = 1): boolean {
  const doneCount = state.completed.length;
  return doneCount > 0 && doneCount % interval === 0;
}
