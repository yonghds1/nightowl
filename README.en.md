# @yonghds1/nightowl

English | [中文](README.md)

Autonomous scheduling skill: **plan** analyzes requirements interactively → **run** executes silently → **report** wraps up. Break a large request into an executable task pool, let the run phase grind through it with no interaction, and get a report when it's done.

Multi-agent host support: **Claude Code / Codex / OpenCode / Antigravity CLI** (`nightowl init --<platform>`). The business core is host-agnostic; only skill install paths, permission models, subagent dispatch, and headless driving are adapted per host.

## Platforms

| Platform | alias | Skill install | Silent/permission | headless (supervise) | Status |
|----------|-------|---------------|-------------------|----------------------|--------|
| Claude Code | `--claude` (default) | `.claude/skills/` | settings.json allow + PreToolUse hook | `claude -p --continue` | ✅ verified (2.1.296) |
| Codex | `--codex` | `.agents/skills/` | TUI/CLI with `--yolo` + trusted hooks.json | `codex exec --yolo resume --last` | ⚠️ hook schema verified; full TUI flow pending |
| OpenCode | `--opencode` | `.agents/skills/` | `opencode.json` permission rules | `opencode run --auto --continue` | ✅ verified (1.18.35) |
| Antigravity CLI | `--antigravity` | `.agents/skills/` + `.agents/agents/` | global `~/.gemini/antigravity-cli/settings.json` allow | `agy -p --dangerously-skip-permissions --continue` | ✅ verified (1.3.4) |

> Codex/OpenCode/Antigravity share `.agents/skills/` (a cross-agent standard dir) — one install is read by all three. Skill bodies are host-agnostic; `init` renders per-platform differences (subagent dispatch / asking tool / launch commands) from `{{PLATFORM_*}}` placeholders. Real CLI verification log: [`docs/platform-verification.md`](docs/platform-verification.md). Design & research: [`docs/multi-agent-plan.md`](docs/multi-agent-plan.md).

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

## Codex: TUI vs CLI

Nightowl creates/removes Git worktrees and commits code. Codex `workspace-write` protects `.git`, so it cannot support the run phase; use full-access `--yolo` (an alias for `--dangerously-bypass-approvals-and-sandbox`). This disables approvals and sandboxing, so use it only in trusted repositories.

**Interactive TUI**: run `nightowl init -u <your-name> --codex` in the project, exit Codex completely, then start it with `codex --yolo`. In the TUI run `/hooks` and trust the project's `.codex/hooks.json`, trigger one tool call, then run `nightowl selfcheck`. Start Nightowl only after it prints `PERMISSION_MODE: bypass`.

**Non-interactive CLI / supervise**: start with `codex exec --yolo "<prompt>"`; resume with `codex exec --yolo resume --last "<continuation prompt>"`. `nightowl supervise` invokes Codex this way and also bypasses Git-root and hook-trust interaction for unattended runs.

## Staged workflows

Compile workflow YAML into a task pool for the existing scheduler, without a separate execution engine:

```yaml
name: feature-delivery
stages:
  - id: implement
    agent: developer
    gate_commands: ["npm run typecheck"]
    tasks:
      - id: CODE
        title: Implement the feature
        priority: P1
        est_min: 30
  - id: review
    agent: reviewer
    depends_on: [implement]
    gate_commands: ["npm test"]
    tasks:
      - id: REVIEW
        title: Review the feature
        priority: P1
        est_min: 15
```

```bash
nightowl workflow generate --intent "Add login" --no-apply   # Infer a template
nightowl workflow generate --intent "Inspect auth" --template audit --no-apply
nightowl workflow generate --template bugfix --no-apply     # Explicit template
nightowl workflow generate workflow.yaml            # Save workflow and replace the pool by default
nightowl workflow generate workflow.yaml --no-apply # Save/validate only; leave the pool unchanged
nightowl workflow generate --apply                  # Reapply the saved workflow
nightowl workflow list                             # List stages, agents, tasks and dependencies
```

`--template` accepts `feature`, `bugfix`, `refactor`, or `audit` and overrides Chinese/English `--intent` inference. Inference checks audit, then bugfix, then refactor keywords; other intents default to feature. A file cannot be combined with `--intent` / `--template`; empty intents and unknown templates fail before writing. Omitting all sources still reapplies the saved workflow.

| Template | Stages (agent) |
| --- | --- |
| feature | design (architect) → implement (developer) → verify (tester) → review (reviewer) |
| bugfix | diagnose (debugger) → fix (developer) → regression (tester) → review (reviewer) |
| refactor | baseline (tester) → refactor (developer) → regression (tester) → review (reviewer) |
| audit | inspect (auditor) → review (reviewer) → report (auditor) |

Templates are editable scaffolds: save with `--no-apply`, refine actual tasks, acceptance criteria, estimates and gates, then run `generate --apply`. Default gates use `git diff --check`, `npm run typecheck`, and `npm test`; adapt them to the project before execution. A diff check does not prove business acceptance. Audit is read-only investigation and reporting, not automatic remediation. Generated IDs use `<TEMPLATE>-<STAGE>` and repeat across generations; use unique task IDs for new deliveries to avoid inheriting old execution state. `init` installs the `nightowl-workflows` skill on all four platforms; `nightowl-plan` routes staged work to it while simple tasks still use `nightowl add`.

Workflows are saved to `.nightowl/nightowl.workflow.yaml`. Applying replaces `.nightowl/nightowl.tasks.yaml` but **never modifies the independent `nightowl.state.yaml` file** (including completed, blocked and in-progress entries; reused task IDs remain subject to their existing state). Existing `schedule` / `checkpoint` settings are retained unless the workflow overrides them; initialization defaults apply when no pool exists. Each stage needs at least one task. Task `status` defaults to `pending` and `depends_on` to an empty array.

Stage `depends_on` references **stage IDs**; task `depends_on` references **task IDs**. Every prerequisite stage's task IDs are merged into each current task's dependencies and deduplicated. The stage `agent` overrides task `assignee`; `gate_commands` are merged into each task's `verify` and deduplicated. Compilation rejects duplicate stage/task IDs, missing references, stage cycles and cycles in the expanded task graph before overwriting files. Gates run through the existing `nightowl verify` command, not during generation.

## Usage (three phases)

Each phase has a **slash command** entry point (Claude Code, installed to `.claude/commands/nightowl/` by `nightowl init`):

| Slash command | Phase | Purpose |
|---|---|---|
| `/nightowl:plan` | Plan | Analyze requirements interactively, produce a task pool with machine gates |
| `/nightowl:run` | Run | Silent unattended execution of the task pool |
| `/nightowl:report` | Report | Generate the wrap-up report and report back |

Slash commands are optional: saying "build X" / "start" / "report" also triggers the matching skill (`nightowl-plan` / `nightowl-run` / `nightowl-report`) by semantic match — same content, two entry points.

### plan — analyze requirements interactively

- `nightowl init -u <your-name> --<platform>` project-level init: builds the `.nightowl/` task pool + auto-requests permissions + lays skills per platform (Claude → `.claude/skills/`; Codex/OpenCode/Antigravity → `.agents/skills/`, all committed to git, ready after clone); `--scope local` applies permissions to this machine only, `--skip-permissions` skips the permission request. `nightowl status` reports when project skills lag the current package; re-run `init` to refresh
- `nightowl analyze` analyze the project and generate `.nightowl/nightowl.context.md` (stack / entry points / test commands / CI, which the implementer subagent reads first during run)
- `nightowl add` add a task, fields: `--id --title --priority --est-min --assignee --desc --acceptance --depends-on --verify --slug`
- `nightowl status` inspect the task pool

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
| `workflow generate/show/list` | Compile, apply and inspect staged workflows |
| `verify` | Run acceptance command |
| `analyze` | Analyze project docs (produce project context) |
| `review` | Record review result |
| `sweep` | Clean leftover worktrees |
| `push` | Push unpushed commits |
| `report` | Generate report |
| `resume` | Resume after crash |
| `checkpoint` | Checkpoint management |
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
