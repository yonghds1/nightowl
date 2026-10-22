---
name: nightowl-run
description: 静默执行任务池的核心子技能:单仓隔离或混合工作区串行实现→独立门禁验证→审查→收尾,全程无需用户交互。用户说"开工"或续跑任务时使用。
---

# Nightowl Run — 夜间 100% 无人值守静默执行

用户输入“开工”后，进入完全自主静默调度。**无需用户交互，不向用户提问。** 仅执行任务授权范围内的操作，阻塞时记录原因并转入下一任务。

## 1. 开工自检（硬门槛）

固定工作区根目录，调度命令从根目录执行：

```bash
nightowl selfcheck
nightowl preflight
```

- `preflight` 区分 `single-repo`、`mixed`、`plain`。非 Git 根目录无需 `git init`；混合工作区保守检查发现的全部子仓库。
- Git 不可执行、扫描不完整、损坏仓库、detached HEAD、缺提交身份、空仓无 HEAD、未完成的 merge/rebase 等失败均阻断开工。不得靠初始化根仓库或忽略错误绕过。
- 脏工作区、浅克隆、无 remote、幽灵 worktree 默认警告，`--strict` 将警告升级为失败。实现前检查相关目录，存在用户已有改动时 block 受影响任务，不自动 stash/reset 或提交用户改动。
- 非 Git 模式说明是能力边界，不是预检警告；`plain` 可以通过严格检查。
- 输出 `PERMISSION_MODE: bypass` 方可开工。若为 `not_bypass` 或 `unknown`，禁止继续：提示用户切换免确认模式；交互会话使用平台授权界面，新会话可用 {{PLATFORM_RELAUNCH}}。权限文件可由 `nightowl init --skip-permissions` 初始化后再配置、重启会话。

## 2. 核心无人值守主调度循环

读取 `.nightowl/nightowl.context.md`，按任务逐个串行执行，直到 `nightowl next` 无待办。所有模式都必须通过 verify 和 review，不以跳过 Git 操作代替验收。

1. **认领任务**：在根目录运行 `nightowl next`，读取路径、描述、验收要求。
2. **选择执行路径**：运行 `nightowl worktree setup <id>`。
   - 单仓库：进入命令返回的 `.nightowl/worktrees/<id>` 目录实现。
   - 收到 `WORKTREE_SKIPPED:`：不进入或创建 worktree，在原工作区各目标目录实现。任务必须串行，不能并行修改共享原目录；该模式不提供隔离或跨仓自动回滚。
3. **实现与提交**：使用平台子代理执行编码：{{PLATFORM_SUBAGENT_CALL}}。
   - Git 仓库中只暂存本任务相关文件，再运行 `nightowl commit --task <id> -m "feat: 实现目标功能"`。确认所有改动都属于本任务时才使用 `--all`。CLI 自动补 `[#<id>]` 标记。
   - 混合工作区：分别进入本任务涉及的每个 Git 子仓库暂存、提交，使用祖先 `.nightowl/` 任务池；普通目录不要求 Git 提交。禁止在无 Git 根目录调用 commit，禁止遍历提交所有子仓库。
   - `--dir` 会改变 Git 操作目录，不是单独的任务池定位参数。子仓提交时不要用 `--dir <根>`；提交完返回工作区根目录调度。
4. **机器门禁独立验证**：回到根目录运行 `nightowl verify --id <id>`。
   - 单仓库优先使用已有 worktree，成功回执绑定该 Git HEAD。
   - 混合工作区的门禁必须明确路径，例如 `cd "repo a" && npm test`；普通目录也必须有客观检查。无统一 HEAD 时回执明确告警，不具备跨仓版本绑定，不能声称所有仓库版本已锁定。
   - 每次验收开始即作废旧通过回执。失败、运行中或命令变更后的旧回执不可用于 done；失败读取 `.nightowl/tasks/<id>/feedback.json` 定向修复，不能强行跳过；无法修复则 block。
5. **审查裁决**：必须先验收再审查，审查绑定当前成功轮次；任何重新验收都需再次审查，不能复用旧 PASS。核对代码、实际验收结果及相关子仓提交状态，运行 `nightowl review <id> --result PASS`。非 Git 模式的 done 不会机器核验每个子仓提交，审查时必须检查，不得把它当成已有保障。
6. **合入与清理**：回到根目录运行 `nightowl worktree merge <id>` 和 `nightowl worktree cleanup <id>`。
   - 单仓库：检查版本后合并并重跑门禁；失败自动回滚合并。使用 `git worktree remove` 安全移除，未提交内容保留现场。
   - 非 Git 根：接受 `WORKTREE_MERGE_SKIPPED:`、`WORKTREE_CLEAN_SKIPPED:`，继续下一步；这些输出不表示对子仓执行了合并或清理。
7. **完成**：运行 `nightowl done <id>`。阻塞时 `nightowl block <id> "<原因>"`，再取下一任务；不无限重试。

## 3. 收尾与晨会报告

运行 `nightowl sweep --clean` 检查残留，接受非 Git 模式的 `SWEEP_CLEAN`。仅在任务明确要求推送时执行对应仓库的推送；根目录 `nightowl push` 返回 `PUSH_SKIPPED_NO_GIT` 时没有推送任何子仓，不能声称代码已推送。

```bash
nightowl report
```

生成 `.nightowl/nightowl.report.md`。汇报任务结果、阻塞、各相关仓库实际提交/推送情况，以及本次是否采用无隔离、无统一版本绑定的降级模式。
