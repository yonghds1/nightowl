# @yonghds1/nightowl

English | [中文](README.md)

Autonomous scheduling skill: **plan** analyzes requirements interactively → **run** executes silently → **report** wraps up. Break a large request into an executable task pool, let the run phase grind through it with no interaction, and get a report when it's done.

## Install

```bash
npm install -g @yonghds1/nightowl
```

After install:

- The global `nightowl` command is available
- Run `nightowl init` once in each project (see below) — skills are laid down per project and committed to git

> **Skills live in projects only** (installed per project via `init`), not as a global copy. The old global `~/.claude/skills/nightowl-*` is retired — delete it if you installed it manually, to avoid drift with the project skills. After a package upgrade run `nightowl status`; if it reports "project skills vX < current package vY", re-run `nightowl init` to refresh.

## Language

CLI output is bilingual (default Chinese). Switch to English with the environment variable:

```bash
NIGHTOWL_LANG=en nightowl status
```

## Quick start

```bash
# 1. Project-level init: creates the .nightowl/ task pool + requests permissions + lays skills into .claude/
#    -u <your-name> writes the developer identity (.nightowl/.developer)
#    --claude selects the Claude Code platform (currently the only one supported)
nightowl init -u <your-name> --claude

# 2. Add a task (auto-generates a PRD document)
nightowl add --id T1 --title "implement string_reverse" --priority P0 --est-min 15 \
  --desc "Add a string_reverse function in src/utils.ts" \
  --acceptance "empty string returns empty; reverse is correct" \
  --verify "npm test"

# 3. Inspect the task pool
nightowl status
```

## Usage (three phases)

### plan — analyze requirements interactively

- `nightowl init -u <your-name> --claude` project-level init: builds the `.nightowl/` task pool + auto-requests permissions + lays skills into `.claude/skills/nightowl-*` (all committed to git, ready after clone); `--scope local` applies permissions to this machine only, `--skip-permissions` skips the permission request. `nightowl status` reports when project skills lag the current package; re-run `init` to refresh
- `nightowl analyze` analyze the project and generate `.nightowl/nightowl.context.md` (stack / entry points / test commands / CI, which the implementer subagent reads first during run)
- `nightowl add` add a task, fields: `--id --title --priority --est-min --assignee --desc --acceptance --depends-on --verify --slug`
- `nightowl status` inspect the task pool
- `nightowl schedule` adjust scheduling times (`--start --end --safety --retry-budget`)

### run — execute silently (no interaction)

- `nightowl next` fetch the next task: emits the scheduling protocol (`WORKTREE_ROOT` / tab-separated fields / `PRD_PATH` / `DESCRIPTION` / `ACCEPTANCE` / `VERIFY`) with resume detection (`# RESUME_MERGE` / `# RESUME_COMMITTED` / `# RESUME in_progress`)
- `nightowl review <id> --result PASS` record a review (`--level full|light`, multiple rounds go into history)
- `nightowl verify <id>` run the acceptance command; records `verify_passed` on success
- `nightowl done <id> <actual_min>` mark done, gated by **review gate + test gate** (`--force` bypasses)
- `nightowl block <id> <reason>` block (saves a checkpoint immediately)
- `nightowl sweep` clean up leftover worktrees (reclaims half-done work after an interrupted resume)
- `nightowl push` push unpushed commits (`PUSH_OK` / `PUSH_NOTHING` / `PUSH_SKIPPED_NO_REMOTE`)

**Unattended**: use `nightowl supervise` in the run phase as the driver engine instead of a manual loop — it repeatedly launches `claude -p --continue` to extend the main session and advance the pool, **exiting automatically when the pool completes** (if the report was not written, it launches a finalize round to guarantee it — exiting means the run fully finished); restarting after an interruption resumes from the checkpoint (`--continue` + idempotent resume, no re-implementation of finished tasks). Common flags: `--interval-sec` / `--timeout-min` / `--max-idle`; `--once` for debugging.

### report — wrap up (default after run)

- `nightowl report` generate `.nightowl/nightowl.report.md` (task overview / blocked / review history / git history), auto-cleans checkpoints when all done
- `nightowl resume` crash recovery: restore pool/state from checkpoint
- `nightowl checkpoint <save|load|clear|status>` manage checkpoints (dual-buffer rotation, always one complete copy)

## All commands

| Command | Description |
|---------|-------------|
| `init` | Project-level init: task pool + permissions + skills (`-u <name> --claude`) |
| `add` | Add a task |
| `status` | Show status |
| `next` | Next task |
| `done` | Mark done (review + test gate) |
| `block` | Block |
| `schedule` | Scheduling time |
| `verify` | Run acceptance command |
| `analyze` | Analyze project docs (produce project context) |
| `review` | Record review result |
| `sweep` | Clean leftover worktrees |
| `push` | Push unpushed commits |
| `report` | Generate report |
| `resume` | Resume after crash |
| `checkpoint` | Checkpoint management |
| `setup-permissions` | Top up permissions |
| `supervise` | Unattended main-session driver (repeatedly launches claude to continue run, exits when pool completes) |

## Project-level skills

`nightowl init` lays skills down per project (trellis-style, committed to git, ready after clone):

- Skills → `.claude/skills/nightowl-plan/`, `nightowl-run/`, `nightowl-report/`
- Template hashes recorded in `.nightowl/.template-hashes.json`: per-file hash + skill source version stamp. Re-run `nightowl init` after a package upgrade auto-updates uncustomized files; locally customized ones are skipped (`--force` overwrites). `nightowl status` reports when project skills lag the current package version
- Identity → `.nightowl/.developer` (written by `-u`, consider adding to .gitignore)

## How it works

All state lives in the project-root `.nightowl/` directory, independent of conversation memory:

| File | Purpose |
|------|---------|
| `nightowl.tasks.yaml` | Task pool (schedule / checkpoint / pool) |
| `nightowl.state.yaml` | Runtime state (completed / blocked / in_progress) |
| `nightowl.checkpoint.yaml`(+`.backup`) | Checkpoint, dual-buffer atomic writes |
| `nightowl.log` | Operation log |
| `nightowl.supervisor.log` | Unattended driver log (per-round supervise status and host output) |
| `nightowl.context.md` | Project context (`analyze` generates; the implementer subagent reads it first) |
| `nightowl.report.md` | Wrap-up report (`report` generates) |
| `.template-hashes.json` | Skill template hashes + skill source version stamp (`init` update detection / `status` version check) |
| `.developer` | Developer identity (written by `init -u`), consider adding to .gitignore |
| `tasks/<assignee>/<MM-DD-slug>/prd.md` | PRD document for each task (grouped by assignee) |

The `--dir <project root>` global option points nightowl at a project root from any directory (defaults to the current one).

## Development

```bash
npm run build      # tsc compile to dist/
npm test           # build + full vitest suite
npm run dev        # run src/cli.ts directly via tsx
npm run typecheck  # type check
```

## License

[ISC](LICENSE)
