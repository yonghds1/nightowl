# @yonghds1/nightowl

[English](README.en.md) | 中文

自主调度技能：**plan** 交互式分析需求 → **run** 静默执行 → **report** 收尾汇总。把大需求拆成可执行的任务池，run 阶段无交互地跑完，收尾给你一份报告。

## 安装

```bash
npm install -g @yonghds1/nightowl
```

安装后：

- 全局 `nightowl` 命令可用
- 在每个项目里跑一次 `nightowl init`(见下),技能按项目铺入并进 git

> **技能只在项目里(按项目 `init` 铺入)**,不再维护全局拷贝。旧的全局 `~/.claude/skills/nightowl-*` 已退场,曾手动装过请删除,避免与项目技能混用漂移。包升级后跑一次 `nightowl status`,若提示"项目技能 vX < 当前包 vY",重跑 `nightowl init` 重铺即可。

## 语言

CLI 界面与命令帮助默认中文；用环境变量切英文：

```bash
NIGHTOWL_LANG=en nightowl --help
```

## 快速开始

```bash
# 1. 项目级初始化：建 .nightowl/ 任务池 + 申请权限 + 铺技能到 .claude/
#    -u <你的名字> 写入开发者身份 (.nightowl/.developer)
#    --claude 指定 claude 平台；--codex 或 --platform codex 用 codex
nightowl init -u <你的名字> --claude

# 2. 拆任务（自动生成 PRD 文档）
nightowl add --id T1 --title "实现 string_reverse" --priority P0 --est-min 15 \
  --desc "在 src/utils.ts 添加 string_reverse 函数" \
  --acceptance "空串返回空;反转正确" \
  --verify "npm test"

# 3. 查看任务池
nightowl status
```

## 使用流程（三阶段）

### plan —— 交互式分析需求

- `nightowl init -u <你的名字> --claude` 项目级初始化：建 `.nightowl/` 任务池 + 自动申请权限 + 铺技能到 `.claude/skills/nightowl-*`（全部进 git，clone 后即用）；`--scope local` 权限只对本机生效，`--skip-permissions` 跳过权限申请。技能版本落后当前包时 `nightowl status` 会提示，重跑 `init` 重铺
- `nightowl analyze` 分析项目上下文，生成 `.nightowl/nightowl.context.md`（技术栈/入口/测试命令/CI，run 阶段实现子代理先读它）
- `nightowl add` 加任务，字段：`--id --title --priority --est-min --assignee --desc --acceptance --depends-on --verify --slug`
- `nightowl status` 看任务池
- `nightowl schedule` 调整重试预算（`--retry-budget`）

### run —— 静默执行（无交互）

- `nightowl next` 取下一个任务：输出调度协议（`WORKTREE_ROOT` / 制表符字段 / `PRD_PATH` / `DESCRIPTION` / `ACCEPTANCE` / `VERIFY`），并带续跑检测（`# RESUME_MERGE` / `# RESUME_COMMITTED` / `# RESUME in_progress`）
- `nightowl review <id> --result PASS` 记录审查（`--level full|light`，多轮结果进 history）
- `nightowl verify <id>` 跑验收命令，通过记录 `verify_passed`
- `nightowl done <id> <actual_min>` 标记完成，**审查关口 + 测试关口**校验（`--force` 跳过）
- `nightowl block <id> <reason>` 阻塞（立即保存 checkpoint）
- `nightowl sweep` 清查残留 worktree（中断续跑先回收半成品）
- `nightowl push` 推送未推送的 commit（`PUSH_OK` / `PUSH_NOTHING` / `PUSH_SKIPPED_NO_REMOTE`）

**无人值守**：run 阶段可用 `nightowl supervise` 作为驱动引擎替代手动循环——反复拉起 `claude -p --continue` 延续主会话推进任务池，**任务池全部完成自动退出**（报告未落盘会自动拉起收尾轮兜底，退出即 run 完整结束）；中断后再启动即从断点续（`--continue` 续接 + resume 幂等，不重复实现已完成任务）。常用 `--interval-sec` / `--timeout-min` / `--max-idle`，调试用 `--once`。

### report —— 收尾汇总（run 后默认执行）

- `nightowl report` 生成 `.nightowl/nightowl.report.md`（任务总览 / 阻塞 / 审查过程 / git 历史），全部完成自动清理 checkpoint
- `nightowl resume` 崩溃续跑：从 checkpoint 恢复 pool/state
- `nightowl checkpoint <save|load|clear|status>` 管理 checkpoint（双轮切换，始终留一份完整数据）

## 全部命令

| 命令 | 说明 |
|------|------|
| `init` | 项目级初始化：任务池 + 权限 + 技能（`-u <名字> --claude`） |
| `add` | 加任务 |
| `status` | 看状态 |
| `next` | 下一个任务 |
| `done` | 标记完成（审查 + 测试关口） |
| `block` | 阻塞 |
| `schedule` | 重试预算 |
| `verify` | 跑验收命令 |
| `analyze` | 项目文档分析（产出项目上下文） |
| `review` | 记录审查结果 |
| `sweep` | 清查残留 worktree |
| `push` | 推送未推送 commit |
| `report` | 生成报告 |
| `resume` | 崩溃续跑 |
| `checkpoint` | checkpoint 管理 |
| `setup-permissions` | 补权限 |
| `supervise` | 无人值守驱动主会话（循环拉起 claude 延续 run，任务池完成退出） |

## 项目级技能

`nightowl init` 会把技能按项目铺入（trellis 式，进 git，clone 后即用）：

- 技能 → `.claude/skills/nightowl-plan/`、`nightowl-run/`、`nightowl-report/`
- 模板 hash 记录在 `.nightowl/.template-hashes.json`：记录每个铺入文件的 hash + 技能来源版本戳。包升级后再次 `nightowl init` 自动更新未定制的文件；被本地定制过的跳过（`--force` 覆盖）。`nightowl status` 检测项目技能版本落后当前包时提示重跑 `init`
- 身份 → `.nightowl/.developer`（`-u` 写入，建议加入 .gitignore）

## 工作原理

状态全部落在项目根 `.nightowl/` 目录，不依赖对话记忆：

| 文件 | 用途 |
|------|------|
| `nightowl.tasks.yaml` | 任务池（schedule / checkpoint / pool） |
| `nightowl.state.yaml` | 运行时状态（completed / blocked / in_progress） |
| `nightowl.checkpoint.yaml`(+`.backup`) | checkpoint，双轮切换原子写 |
| `nightowl.log` | 操作日志 |
| `nightowl.supervisor.log` | 无人值守驱动日志（supervise 每轮状态与宿主输出） |
| `nightowl.context.md` | 项目上下文（`analyze` 生成，实现子代理先读它） |
| `nightowl.report.md` | 收尾报告（`report` 生成） |
| `.template-hashes.json` | 技能模板 hash + 技能来源版本戳（`init` 更新检测 / `status` 版本自检） |
| `.developer` | 开发者身份（`init -u` 写入），建议加入 .gitignore |
| `tasks/<assignee>/<MM-DD-slug>/prd.md` | 每个任务关联的 PRD 文档(按负责人分层) |

`--dir <项目根>` 全局选项可在任意目录指定项目根（默认当前目录）。

## 开发

```bash
npm run build      # tsc 编译到 dist/
npm test           # 构建 + vitest 全量测试
npm run dev        # tsx 直接跑 src/cli.ts
npm run typecheck  # 类型检查
```

## License

[ISC](LICENSE)
