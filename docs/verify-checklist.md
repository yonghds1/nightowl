# Nightowl 多平台实测 Checklist

配合 `docs/verify-platform.sh <platform>` 使用。脚本把"准备阶段"(init + 一个零依赖 T1)自动化;
**run 必须在真实 agent 会话里发生**,本文件告诉你每家平台该观察什么、预期信号、失败长什么样。

T1 故意设计成"创建一个 `nightowl-smoke.txt` 内容为 `nightowl-ok`"——不依赖任何语言栈,
只验证 nightowl 的调度机制本身:技能发现 → 子代理派发 → worktree 隔离 → verify → 合并回主分支 → done → report。

通用成功判据(任何平台都该满足):
```
nightowl status                       # T1 显示 completed
cat nightowl-smoke.txt                # nightowl-ok
git log --oneline                     # 有一条 commit message 含 T1,且已在主分支
git worktree list                     # 只剩主工作区(子代理用过的 worktree 已删)
test -f .nightowl/nightowl.report.md  # report 落盘
```

---

## Claude Code（基线，已实战）
- **发现技能**：项目里 `/` 能看到 `nightowl-plan` / `nightowl-run` / `nightowl-report`；技能在 `.claude/skills/`。
- **静默前提**：`claude --dangerously-skip-permissions` 启动，`nightowl selfcheck` → `PERMISSION_MODE: bypass`。
- **子代理**：run 用 Agent 工具 + `isolation="worktree"`，worktree 托管、回收即删。
- **失败信号**：中途弹权限确认（说明没 bypass）；worktree 残留（`git worktree list` 多个）。

## Codex（🧪 待实测）
- **发现技能**：技能在 `.agents/skills/`（官方扫描 CWD→repo root）。开会话问"你现在有哪些 skills"确认 nightowl-* 出现。
  - ⚠️ **先信任项目**：项目级 `.codex/config.toml` / hooks 仅在 trusted 项目加载。首次用 Codex 打开该 repo 要确认已信任。
- **静默前提**：`nightowl selfcheck`。无 hook 时兜底读 `CODEX_PID`——若 Codex 不设该 env，selfcheck 可能 `unknown`，
  此时改以 headless `codex exec` 验证（exec 默认按 config 的 approval_policy 走）。
- **子代理派发**：run 会要求主代理手动 `git worktree add` 再派 worker 子代理在 worktree 目录实现。**观察**：
  子代理是否真在 worktree 内写文件（不污染主工作区）、commit 是否落在任务分支、是否合并回主分支后删了 worktree。
- **失败信号**：`git push` 失败（确认 config 里 `[sandbox_workspace_write] network_access = true` 生效）；
  子代理忽略 worktree 约束直接改主工作区；`codex exec resume --last` 首轮无历史的行为。

## OpenCode（🧪 待实测）
- **发现技能**：OpenCode 兼容读 `.agents/skills`（本仓库也读 `.claude/skills`——**注意**：若你曾在此项目 `init --claude`，
  会两份重复，需删 `.claude/skills/nightowl-*`）。TUI 里让 agent 列可用 skill 确认。
- **静默前提**：`nightowl init --opencode` 已把 `opencode.json` 的 permission 设为 bash/edit/write/task/skill=allow。
  `nightowl selfcheck` 读该配置 → `bypass`。或启动 `opencode --auto` / 命令面板开 auto-approve。
- **子代理派发**：用内置 `general` 子代理（task 工具），主代理手动建 worktree。**观察**同上（worktree 隔离、合并、删除）。
- **失败信号**：run 中途弹权限（permission 没被读到，检查 `opencode.json` 位置）；`opencode run --auto --continue` 续接行为。

## Antigravity CLI（🧪 待实测，风险最高）
- **发现技能**：技能在 `.agents/skills/`；子代理定义在 `.agents/agents/nightowl-{implementer,reviewer}.md`。
- **静默前提（关键）**：Antigravity 在 **headless 下未授权动作是 soft-deny——静默跳过、不报错、exit 0**。
  这意味着若权限没放开，run 会"看起来跑完了但实际什么都没做"。**必查**：
  - 全局 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 是否含 nightowl 铺入的规则（脚本已用 `AGY_SETTINGS_FILE` 指到临时项目内）；
  - 或直接 `agy -p --dangerously-skip-permissions` / `nightowl supervise`（supervise 已注入该 flag）。
  - 判"真做了"而非"被跳过"：看 `nightowl status` 是否 `completed`、`nightowl-smoke.txt` 是否真生成。
- **子代理派发**：`invoke_subagent` 调自定义 `nightowl-implementer`。**观察**：子代理定义被识别、能在 worktree 内实现并 commit。
- **失败信号**：任务标 completed 但文件没生成（soft-deny 被吞）；子代理不被发现（frontmatter/路径问题）。

---

## 验证后

- 有偏差 → 把"预期 vs 实际"贴回来，按真实 CLI 行为修对应平台代码（headless 参数、detectBypass、子代理派发说明、技能路径）。
- 全绿 → 把 README 平台矩阵该行的 🧪 改成 ✅。
- 清理：`rm -rf <verify-platform.sh 末尾打印的临时目录>`。
