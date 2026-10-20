# Nightowl Run

进入 run 阶段:静默执行任务池。**全程不向用户提问、不弹权限确认。**

## 开工前自检

1. 会话必须是 bypass 权限模式(否则 run 会弹权限确认,破坏静默):非 bypass → 提示切到 bypass 或先走 plan。
2. 在项目根目录、git 工作区干净。

## 流程

1. 读项目上下文:`.nightowl/nightowl.context.md`(plan 阶段已生成,直接复用;项目结构有变化可 `nightowl analyze` 刷新)。
2. 进入调度循环:
   ```
   while True:
     nightowl sweep --clean              # 清残留 worktree(SWEEP_CLEAN 则继续)
     nightowl status                     # 看状态
     nightowl next                       # 取下一个任务(含 RESUME 检测)
     # 派实现子代理(worktree 隔离) → 实现→审查→测试→提交→合并回主分支→删 worktree
     nightowl done <id> <actual_min>     # 过审查+测试关口
   ```
3. 无任务 → 收尾:`nightowl push` 推送未推送 commit。
4. 生成报告:`nightowl report`,向用户汇报。

## 协议输出

`next` 输出的 `# RESUME_MERGE`/`# RESUME_COMMITTED`/`# RESUME in_progress`/`NO_TASK`、`WORKTREE_ROOT:`/`PRD_PATH:`/`DESCRIPTION:`/`ACCEPTANCE:`/`VERIFY:`、`sweep` 的 `SWEEP_CLEAN`/`SWEEP_REMOVED:`/`SWEEP_KEEP_UNMERGED:`/`SWEEP_KEEP_DIRTY:`、`push` 的 `PUSH_OK`/`PUSH_NOTHING`/`PUSH_SKIPPED_NO_REMOTE`/`PUSH_SKIPPED_NO_GIT`、非 git 降级的 `WORKTREE_SKIPPED:`/`WORKTREE_MERGE_SKIPPED:`/`WORKTREE_CLEAN_SKIPPED:` 是调度循环解析的机器协议,保持原样。

## 原则

- 每个任务过 5 道关:实现→审查→测试→提交→合并,worktree 即用即删。
- 失败自动 retry,耗尽 block,不无限重试。
- 一切进度落盘 `.nightowl/`,不依赖对话记忆。

## 非 git 根目录(多仓父目录)降级

项目根不是 git 仓库(任务实现在子仓库里完成)时,隔离类命令自动降级,流程不断:
`worktree setup` 输出 `WORKTREE_SKIPPED:`、`worktree merge` 输出 `WORKTREE_MERGE_SKIPPED:`、`cleanup` 输出 `WORKTREE_CLEAN_SKIPPED:`、`push` 输出 `PUSH_SKIPPED_NO_GIT`。看到这些 token 直接跳到下一步:在主目录直接实现,verify/review/done 照走;子仓库的提交与推送由任务命令自带(`cd <子仓> && git ...`)。
