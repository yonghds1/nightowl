# @yonghds1/nightowl

English | [中文](README.md)

Autonomous scheduling skill: **plan** analyzes requirements interactively → **run** executes silently → **report** wraps up. Break a large request into an executable task pool, let the run phase grind through it with no interaction, and get a report when it's done.

Multi-agent host support: **Claude Code / Codex / OpenCode / Antigravity CLI** (`nightowl init --<platform>`). The business core is host-agnostic; only skill install paths, permission models, subagent dispatch, and headless driving are adapted per host.

## Platforms

| Platform | alias | Skill install | Silent/permission | headless (supervise) | Status |
|----------|-------|---------------|-------------------|----------------------|--------|
| Claude Code | `--claude` (default) | `.claude/skills/` | settings.json allow + PreToolUse hook | `claude -p --continue` | ✅ battle-tested |
| Codex | `--codex` | `.agents/skills/` | `.codex/config.toml` (never + workspace-write + network) + hooks.json | `codex exec resume --last` | 🧪 per-docs, not yet verified on real CLI |
| OpenCode | `--opencode` | `.agents/skills/` | `opencode.json` permission rules | `opencode run --auto --continue` | 🧪 per-docs, not yet verified on real CLI |
| Antigravity CLI | `--antigravity` | `.agents/skills/` + `.agents/agents/` | global `~/.gemini/antigravity-cli/settings.json` allow | `agy -p --dangerously-skip-permissions --continue` | 🧪 per-docs, not yet verified on real CLI |

> Codex/OpenCode/Antigravity share `.agents/skills/` (a cross-agent standard dir) — one install is read by all three. Skill bodies are host-agnostic; `init` renders per-platform differences (subagent dispatch / asking tool / launch commands) from `{{PLATFORM_*}}` placeholders. Design & research: [`docs/multi-agent-plan.md`](docs/multi-agent-plan.md).

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
# 1. Project-level init: creates the .nightowl/ task pool + requests permissions + lays skills per platform
#    -u <your-name> writes the developer identity (.nightowl/.developer)
#    platform alias: --claude (default) / --codex / --opencode / --antigravity; or --platform <id>
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

- `nightowl init -u <your-name> --<platform>` project-level init: builds the `.nightowl/` task pool + auto-requests permissions + lays skills per platform (Claude → `.claude/skills/`; Codex/OpenCode/Antigravity → `.agents/skills/`, all committed to git, ready after clone); `--scope local` applies permissions to this machine only, `--skip-permissions` skips the permission request. `nightowl status` reports when project skills lag the current package; re-run `init` to refresh
- `nightowl analyze` analyze the project and generate `.nightowl/nightowl.context.md` (stack / entry points / test commands / CI, which the implementer subagent reads first during run)
- `nightowl add` add a task, fields: `--id --title --priority --est-min --assignee --desc --acceptance --depends-on --verify --slug`
- `nightowl status` inspect the task pool
- `nightowl schedule` adjust scheduling times (`--start --end --safety --retry-budget`)

### run — execute silently (no interaction)

- `nightowl next` fetch the next task: emits the scheduling protocol (`WORKTREE_ROOT` / tab-separated fields / `PRD_PATH` / `DESCRIPTION` / `ACCEPTANCE` / `VERIFY`) with resume detection (`# RESUME_MERGE` / `# RESUME_COMMITTED` / `# RESUME in_progress`)
- `nightowl review <id> --result PASS` record a review (`--level full|light`, multiple rounds go into history)
- `nightowl verify <id>` run the acceptance command; records `verify_passed` on success
- `nightowl done <id> <actual_min>` mark done, gated by **review gate + test gate + git check** (verifies the main branch has a commit tagged `[#<id>]`; Claude warns only, other platforms block by default — `--require-commit` forces it everywhere, `--force` bypasses all gates)
- `nightowl block <id> <reason>` block (saves a checkpoint immediately)
- `nightowl sweep` clean up leftover worktrees (reclaims half-done work after an interrupted resume)
- `nightowl push` push unpushed commits (`PUSH_OK` / `PUSH_NOTHING` / `PUSH_SKIPPED_NO_REMOTE`)

**Unattended**: use `nightowl supervise` in the run phase as the driver engine instead of a manual loop — per platform it repeatedly launches the host's headless session (Claude `claude -p --continue`, Codex `codex exec resume --last`, OpenCode `opencode run --auto --continue`, Antigravity `agy -p --dangerously-skip-permissions --continue`) to extend the main session and advance the pool, **exiting automatically when the pool completes** (if the report was not written, it launches a finalize round to guarantee it — exiting means the run fully finished); restarting after an interruption resumes from the checkpoint (session continuation + idempotent resume, no re-implementation of finished tasks). Common flags: `--interval-sec` / `--timeout-min` / `--max-idle`; `--once` for debugging.

### report — wrap up (default after run)

- `nightowl report` generate `.nightowl/nightowl.report.md` (task overview / blocked / review history / git history), auto-cleans checkpoints when all done
- `nightowl resume` crash recovery: restore pool/state from checkpoint
- `nightowl checkpoint <save|load|clear|status>` manage checkpoints (dual-buffer rotation, always one complete copy)

## All commands

| Command | Description |
|---------|-------------|
| `init` | Project-level init: task pool + permissions + skills (`-u <name> --<platform>`) |
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
| `supervise` | Unattended main-session driver (per-platform headless loop to continue run, exits when pool completes) |

## Project-level skills

`nightowl init` lays skills down per project (trellis-style, committed to git, ready after clone):

- Skills → Claude: `.claude/skills/nightowl-{plan,run,report}/`; Codex/OpenCode/Antigravity: `.agents/skills/nightowl-{plan,run,report}/` (cross-agent shared dir)
- Antigravity additionally lays subagent defs `.agents/agents/nightowl-{implementer,reviewer}.md` (for `invoke_subagent`)
- Skill bodies are host-agnostic; `init` renders `{{PLATFORM_*}}` placeholders into per-platform subagent-dispatch / asking / launch behavior (re-run `init` after switching platform to re-lay the rendered version)
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
