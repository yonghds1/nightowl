---
name: nightowl-run
description: 静默执行任务池的核心子技能:自动循环派发任务"隔离实现→独立门禁验证→审查→合并收尾",全程无需用户交互。用户说"开工"或续跑任务时使用。
---

# Nightowl Run — 夜间 100% 无人值守静默执行

用户输入“开工”后，进入完全自主静默调度。**所有操作自动确认，无需用户交互，不向用户提问。**

## 1. 开工自检（硬门槛）
开工第一步必须先自检权限与工作区状态：
```bash
nightowl selfcheck
nightowl preflight
```
- `nightowl preflight` 体检 git 环境：失败项（未初始化 / detached HEAD / 无提交身份 / 未完成的 merge）必须先按提示修复；警告项（工作区脏 / 浅克隆 / 无 remote / 幽灵 worktree）记下即可，`--strict` 可把警告也当失败。
- 输出 `PERMISSION_MODE: bypass` 且工作区无未跟踪/未暂存风险方可开工；
- 若输出 `not_bypass` 或 `unknown`：**本技能不可用，必须停下开工动作，向用户弹权限申请**——
  明确告诉用户「nightowl-run 需要无权限确认模式，请以以下方式启动/授权」并等待用户操作后重新自检：
  - 交互会话：让用户在平台交互界面切换到 bypass/免确认模式（如 Claude Code 用
    `--dangerously-skip-permissions` 重启,或弹出权限批准框后让用户选择 Always allow）；
  - 新起 会话/headless：以无权限确认模式重启({{PLATFORM_RELAUNCH}})，或运行 `nightowl init --skip-permissions` 后重启会话。
- 在拿到 `PERMISSION_MODE: bypass` 之前，**禁止**继续执行本技能后续任何步骤——
  静默调度一旦半途开始弹权限确认，无人值守契约即被破坏；宁可不开工，不可半开工。

## 2. 核心无人值守主调度循环
逐个任务循环执行以下标准原子流水线，直至 `nightowl next` 显示无待办任务：

```
获取任务 ➔ 隔离工作区 ➔ 编写代码 ➔ 独立门禁 ➔ 审查裁决 ➔ 安全合并 ➔ 现场清理
```

1. **认领任务**：
   运行 `nightowl next` 获取待办任务 ID 及详细验收门禁要求。
2. **构建隔离工作区**：
   运行 `nightowl worktree setup <id>`，进入 `worktrees/<id>` 独立目录工作，杜绝污染主仓。
3. **调度实现子代理**：
   使用平台子代理执行编码：{{PLATFORM_SUBAGENT_CALL}}。
   在隔离工作区中实现需求，并用 CLI 提交（自动补 `[#<id>]` 标记，默认禁用 GPG 签名与编辑器）：
   `nightowl commit --task <id> -m "feat: 实现目标功能" --all`
4. **机器门禁独立验证 (verify)**：
   运行 `nightowl verify --id <id>`。
   - 验证成功：系统自动绑定代码版本哈希；
   - 验证失败：自动读取 `.nightowl/tasks/<id>/feedback.json` 定向修复，不得强行跳过。
5. **代码审查与裁决**：
   审查代码质量与规范，运行 `nightowl review <id> --result PASS`。
6. **安全合入主分支**：
   在主分支执行 `nightowl worktree merge <id>`。
   （底层自动比对代码版本与验证记录，若代码发生变动必须重新 verify）。
7. **现场安全清理**：
   运行 `nightowl worktree cleanup <id>`。
   （底层调用 git worktree remove 进行安全移除，若有未提交改动默认保留现场，用完即删）。
8. **标记完成**：
   运行 `nightowl done <id>`。若遇到阻塞无法推进，运行 `nightowl block <id> "<原因>"` 并转入下一任务。

## 3. 收尾与晨会报告
所有任务执行完毕后，执行收尾并生成晨会决策看板：
```bash
nightowl report
```
生成 `.nightowl/nightowl.report.md`，并在用户回到会话时主动汇报发版判定、阻塞事项与后续动作。
