# Nightowl Run

进入 run 阶段：静默执行任务池，不向用户提问。完整执行规则读取 `nightowl-run` 技能。

## 开工自检

在固定工作区根目录运行 `nightowl selfcheck` 和 `nightowl preflight`。权限必须为 bypass；真实失败不得忽略。非 Git 根目录无需初始化 Git，预检保守检查发现的全部子仓库。脏改动不自动 stash/reset/提交，block 受影响任务。

## 调度循环

1. 读取 `.nightowl/nightowl.context.md`；必要时 `nightowl analyze` 刷新。
2. 根目录 `nightowl sweep --clean`、`nightowl status`、`nightowl next`。
3. `nightowl worktree setup <id>` 后按输出分流：
   - 单仓库：进入返回的 `.nightowl/worktrees/<id>` 隔离目录。
   - `WORKTREE_SKIPPED:`：原目录串行执行，不创建或进入不存在的 worktree，不并行修改共享目录。
4. 实现后只暂存任务文件，再 `nightowl commit --task <id> -m "实现任务"`。混合工作区分别进入相关 Git 子仓提交，普通目录无需提交。子仓提交复用祖先任务池，不能加 `--dir <根>` 导致 Git 操作回到根目录。
5. 回根目录 `nightowl verify --id <id>`；门禁明确子路径，例如 `cd "repo a" && npm test`。失败修复或 block，不得跳过。非 Git 根回执无统一 HEAD，不具备跨仓版本绑定。
6. 检查验收和各相关子仓提交，`nightowl review <id> --result PASS`。
7. 根目录执行 `nightowl worktree merge <id>`、`nightowl worktree cleanup <id>`；接受非 Git 模式的 `WORKTREE_MERGE_SKIPPED:`、`WORKTREE_CLEAN_SKIPPED:`，不能声称子仓已经合并或清理。
8. `nightowl done <id>`，失败有界重试，不能推进则 `nightowl block <id> "原因"`，转下一任务。
9. 无任务后清理残留并 `nightowl report`。仅任务明确约定时推送对应仓库；根 `nightowl push` 输出 `PUSH_SKIPPED_NO_GIT` 表示没有推送子仓。

## 协议与能力边界

保持 `# RESUME_MERGE`、`# RESUME_COMMITTED`、`# RESUME in_progress`、`NO_TASK`、`WORKTREE_ROOT:`、`PRD_PATH:`、`DESCRIPTION:`、`ACCEPTANCE:`、`VERIFY:`、`SWEEP_CLEAN`、`SWEEP_REMOVED:`、`SWEEP_KEEP_UNMERGED:`、`SWEEP_KEEP_DIRTY:`、`PUSH_OK`、`PUSH_NOTHING`、`PUSH_SKIPPED_NO_REMOTE`、`PUSH_SKIPPED_NO_GIT`、`WORKTREE_SKIPPED:`、`WORKTREE_MERGE_SKIPPED:`、`WORKTREE_CLEAN_SKIPPED:` 原样。

进度落盘 `.nightowl/`。非 Git 根目录的原目录串行执行没有 worktree 隔离、统一 Git 版本绑定或跨仓自动回滚，done 不机器核验全部子仓提交；审查与报告必须如实说明实际提交、推送情况。
