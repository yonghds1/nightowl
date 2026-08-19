---
name: nightowl-run
description: 静默执行任务池的核心子技能:自动派子代理逐任务"实现→审查→测试→提交→合并",收尾推送并默认生成报告。用户说"开工""后台把任务做完",或续跑上一轮未完成任务时使用。
---

# Nightowl Run — 静默执行任务池

run 阶段:用户说"开工"后进入自主调度循环,全程静默。**调度循环是代理(即你)用 Agent 工具 + Bash 执行,不是脚本自动跑**。**所有操作自动确认,无需用户交互,不向用户提问。**

> 编排说明:run 的调度循环当前按 Claude Code 机制(Agent 工具 / worktree 隔离 / checkpoint 续跑)编写;Codex 平台的支持为后续版本(差异:agents TOML 子代理、无斜杠命令)。

## 开工:权限模式自检

**run 阶段必须完全静默**,静默依赖的唯一前提是会话处于 bypass 权限模式。
**开工第一步先自检,发现阻断项(非 bypass 权限 / 已跟踪文件的未提交修改)立即中止**,
不留到中途弹确认:

1. 运行 `nightowl selfcheck` 检查权限模式,**不要凭印象猜,以命令输出为准**:
   - 输出 `PERMISSION_MODE: bypass` → 通过,继续。
   - 输出 `PERMISSION_MODE: not_bypass` / `unknown` → 立即中止,提示:
     "run 需以无权限确认模式启动(按平台:Claude `claude --dangerously-skip-permissions`,
     Codex `codex exec --full-auto`),或切到 bypass 后重启会话让 hook 记录,
     否则 run 阶段会弹权限确认,破坏静默。先走 nightowl-plan 规划流程,或切到 bypass 后重新开工。"
   - 说明:PreToolUse hook 需 `nightowl init` 装好且**新会话**才生效;启动参数型 bypass
     由 selfcheck 兜底读进程 cmdline 检测,未装 hook 也能判断。
2. 确认在项目根目录、检查 git 工作区状态。工作区不干净**先分类,不一律中止**:
   - **已跟踪文件的未提交修改**(`git status` 显示 ` M/MM`):会和子代理 worktree 的
     合并冲突,**必须处理** → 中止,提示"先 `git add` + `git commit`(或 `git stash`)
     把这批改动提交/暂存,再重新开工"。这是硬前提,不带半成品开工。
   - **未跟踪文件/目录**(`git status` 显示 `??`):不进入 worktree、不影响合并,
     **不阻断 run**。在自检报告里说明"是什么文件、为何出现、怎么处理",run 照常进行:
     - **第三方工具或历史流程产物**(目录名带工具名,如 `.trellis/`、`.daynight/` 等):
       先查项目惯例 —— 同类产物历史上是否入库(`git ls-files <目录>` 有结果 = 入库惯例)。
       入库惯例 → 建议"提交归档";不入库 → 建议"补 .gitignore"。两种都不阻断 run。
     - **疑似本次任务相关的新文件**:提示用户确认归属 —— 属本次任务则先提交为基线;
       不属本次任务则按第三方产物处理。
   - **run 阶段不自作主张**:不擅自 `git add`/`commit`/`rm` 无关文件,不删除未跟踪目录;
     处置权在用户(plan 阶段交互处理)。
3. 权限模式 ✅ + 目录 ✅ + 工作区按上分类处理(无关未跟踪产物不阻断)后,才进入调度循环。

**plan=交互 / run=静默**:需求的澄清、颗粒度的确认、权限的获取都在 plan 阶段完成
(见 nightowl-plan),run 阶段不向用户提问、不弹权限确认。

## 开工前:技能版本自检

包升级后项目技能可能落后于 CLI。**开工时 `nightowl status` 输出末尾若提示
"项目技能 vX < 当前包 vY",先静默重跑一次重铺,再进入调度循环**:

```
nightowl init --skip-permissions
```

重铺幂等:不重建任务池、不动权限与任务、不覆盖本地定制文件(有定制则跳过,`--force` 才覆盖),
只是把技能文件同步到当前包版本 —— 避免用旧版技能跑本轮调度。

## 开工前:文档分析

**run 开工,先读项目上下文再碰代码**。`.nightowl/nightowl.context.md` 是 plan 阶段
`nightowl analyze` 已生成的项目上下文(技术栈/入口/测试命令/CI/关键目录),**直接复用,
不重复分析**;若项目结构近期有变化,可重跑刷新:

```
nightowl --dir <项目根目录> analyze
```

输出结构化 `# 项目上下文` 块(技术栈/入口/测试命令/CI/关键目录),写进 nightowl.log,**并落盘到 `.nightowl/nightowl.context.md`**。实现子代理不内嵌长文本,改为先 Read 这个文件(避免长上下文塞 prompt 触发输出截断)。

## 调度循环

```
1. 文档分析(见上),产出项目上下文(同时写入 .nightowl/nightowl.context.md)
2. 进入循环:
while True:
    a. 先清残留 worktree: 运行 `nightowl sweep`
       - 输出一行 `{分支}\t{路径}\t{unmerged}`,第三列非空 → 该 worktree 有未合入
         commit(中断留下的半成品):先 `git merge/cherry-pick` 把 commit 合回当前
         分支,再 `git worktree remove <路径>` + `git branch -d <分支>`,收回来
       - 输出 `SWEEP_CLEAN` → 继续
    b. 运行 `nightowl --dir <项目根目录> status` 看当前状态
    c. 运行 `nightowl next` 拿到下一个任务
       - 若输出 "NO_TASK" → 进入"收尾推送"阶段
       - 若输出 `# RESUME_MERGE <id> <hash>` → 该任务子代理已实现但未合入当前分支:
         直接走"审查 → 合并 → 测试 → done",**不再派实现子代理**(续跑幂等)
       - 若输出 `# RESUME_COMMITTED <id> <hash>` → 已合入当前分支:
         直接走"审查 → 测试 → done",不再实现/合并
       - 若输出 `# RESUME in_progress <id>` → 无实现残留:按正常任务派实现子代理。
         但若 step a 的 sweep 输出里该任务有残留 worktree(普通分支名含任务 id;
         detached 用 `git log -1 <hash> --oneline` 看 commit message 是否含任务 id),
         先按 step a 的回收流程合回主分支并删除,再重派实现
       - 否则解析普通输出(格式见下"next 输出解析")
    d. 派实现子代理:
       Agent 工具,subagent_type="general-purpose",
       mode="bypassPermissions" (所有操作自动确认),isolation="worktree"
       prompt 模板见下"实现子代理"
    e. 子代理完成后,执行"每个任务的完整闭环"(见下):
       实现 → 审查 → 测试 → 提交 → 合并回主分支
       - 子代理在 worktree 分支上 commit 后,把 commit 合回当前分支
         (git merge / git cherry-pick),然后 `git worktree remove` 删除 worktree
       - 审查裁决:解析审查子代理回复**首行**的裁决标记(REVIEW_PASS /
         REVIEW_FAIL / REVIEW_PASS_WITH_NITS)。解析不到 → 该轮审查作废,
         重新派审查子代理(最多 retry_budget 次);仍解析不到 → 视为 FAIL 打回。
       - 任一环节失败 → retry(最多 retry_budget 次)
       - retry 耗尽 → `nightowl block <id> "<原因>"`
    f. 继续下一轮:还有可执行任务 → 回到循环开头;没有 → 进入收尾
3. 收尾推送(见下)
```

### next 输出解析

`nightowl next` 可能以一行 `# 前缀` 开头(续跑/中断恢复时),否则输出普通任务块:

```
# RESUME_MERGE T1 <hash>        # 该任务已有未合入 commit → 走审查/合并/done,不再实现
# RESUME_COMMITTED T1 <hash>    # 该任务 commit 已合入当前分支 → 走审查/测试/done
# RESUME in_progress T1         # 无实现残留 → 正常重派实现子代理
```

普通输出格式:

```
WORKTREE_ROOT: {主工作区绝对路径}
{TASK_ID}\t{TITLE}\t{PRIORITY}\t{EST_MIN}
PRD_PATH: {相对路径或没有}
DESCRIPTION:
{DESCRIPTION 或空}
ACCEPTANCE:
{ACCEPTANCE 或空}
VERIFY: {VERIFY_COMMANDS 或无}
```

解析规则:
1. 首行若以 `# ` 开头 → 按上面 RESUME_* 分支处理,直接读任务字段(第二行起)
2. `WORKTREE_ROOT:` 为**主工作区**绝对路径(实现子代理在 worktree 里用它锚定 .nightowl/ 文件)
3. 下一行用 `\t` 分割得到 id, title, priority, est_min
4. `PRD_PATH:` 后为任务关联的 PRD 文档相对路径(可能没有,来自 add 自动生成)
5. `DESCRIPTION:` 后的内容为任务详细描述(可能多行)
6. `ACCEPTANCE:` 后的内容为验收标准(可能多行)
7. `VERIFY:` 后为逗号分隔的验收命令(可能没有)

## 每个任务的完整闭环

**每个任务不是"写完就提交",而是要过完 5 道关**:

```
实现 → 代码审查 → 测试 → 提交 → 合并
```

| 环节 | 做什么 | 谁做 | 通过标准 |
|------|--------|------|----------|
| **1. 实现** | 在 worktree 里写代码 + 测试 | 实现子代理 | 功能完成 |
| **2. 代码审查** | 审查子代理 review 改动 | 独立的审查子代理 | 无 P0/P1 问题 |
| **3. 测试** | 跑 verify 命令(单测/集成/构建) | 实现子代理或主代理 | 全部通过;有 verify 命令的任务,`done` 前脚本校验 verify_passed(**测试关口**,`--force` 跳过) |
| **4. 提交** | git add + commit(带任务 id) | 实现子代理 | commit 完成 |
| **5. 合并** | 把 worktree 分支 commit 合回主分支,**然后立即删除该 worktree**(`git worktree remove <路径>` + `git branch -d <分支>`) | 主代理 | 主分支包含该任务,`git worktree list` 里该任务 worktree **已消失** |

**审查子代理独立于实现子代理** —— 实现者不审查自己写的代码,这是代码审查的第一原则。

**第 5 道关不能省,且"合并"和"删除"必须成对完成**:worktree 里 commit 不会自动出现在主分支。若不合并回主分支,收尾推送推的是主分支,worktree 里的成果就丢了;**若只合并不删除**,worktree 目录和分支会留在磁盘上,一晚就残留十几个,占磁盘、污染 `git worktree list`(2026-08-10 实战教训:一晚残留 14 个)。合并 + `git worktree remove` 都完成后,主代理再运行 `nightowl done <id> <actual_min>` 记录完成,调度下一个任务。

**worktree 生命周期**:每个任务在隔离 worktree 里实现,完成后**必须**把 commit 合回主分支并删除 worktree,否则会残留大量 worktree 目录和分支。检查是否残留:

```
git worktree list                      # 看有哪些 worktree
git cherry main <worktree分支>          # '+' 表示该分支有 main 没有的提交
```

清理单个残留: `git worktree remove <路径>` + `git branch -d <分支>`。

## 子代理 prompt 模板

### 实现子代理

Agent 工具调用参数:
- subagent_type: "general-purpose"
- mode: "bypassPermissions"
- isolation: "worktree"

prompt 格式(用 next 输出的字段填充):

```
# 项目上下文
主工作区绝对路径: {worktree_root}(你在隔离 worktree 里,.nightowl/ 状态文件不在
这里,用上面的主工作区路径去读)

先 Read {worktree_root}/.nightowl/nightowl.context.md(开工时 analyze 生成的项目
上下文:技术栈/入口/测试命令/CI/关键目录)。

# 任务
任务 ID: {task_id}
任务标题: {title}
任务描述: {description,没有则写"无"}
关联 PRD 文档: {prd_path,没有则写"无"}(有则 Read {worktree_root}/{prd_path})

工作目录: {worktree 路径}
基础分支: {base_branch}

# 验收标准
{acceptance,没有则写"按任务描述实现"}
{逐行列出 verify 命令}

# 要求
0. 先 Read {worktree_root}/.nightowl/nightowl.context.md 和"关联 PRD 文档"(若有)
   ——那是任务的详细需求(Goal/Requirements/Technical Notes)
1. 只在 worktree 里干活,不要碰主工作区
2. 按照任务描述实现功能
3. 写测试覆盖关键逻辑
4. 跑 verify 直到通过(最多 {retry_budget} 次)
5. 通过后 git add + git commit(commit message 带任务 id)
6. verify 失败:自己 debug + retry
7. retry 耗尽仍失败:不要 commit,报告失败原因(含完整错误输出)
8. 完成后报告:改了哪些文件、commit hash、用时

# 权限说明
- 所有操作自动确认,无需用户交互
- 文件读写、命令执行、Git 操作均自动通过
- 目录范围: 当前工作区(项目根目录及其所有子目录)
```

### 审查子代理

**审查分级**:调度方按任务风险挑级别,记录进 `review --level`。

| 级别 | 适用任务 | 覆盖范围 |
|------|----------|----------|
| **full 全量**(默认) | 核心逻辑、跨模块改动、有风险(权限/IO/并发) | 审查清单 1-6 全部:功能正确性、边界情况、代码质量、安全、风格一致性、测试覆盖 |
| **light 快速** | 小改动、纯文档/配置、无风险任务 | 只查清单 1(功能正确性)+ 6(测试覆盖)+ 明显安全问题,其余快速略过 |

```
# 背景
实现子代理刚完成了任务 {task.id}: {task.title}
commit: {commit_hash}
审查分级: {full 或 light}

# 你的职责
独立审查这份改动,不要因为"有人已经做完了"就放水。
{full: 按下面 6 条清单逐项审查}
{light: 只查功能正确性、测试覆盖、明显安全问题,快速过一遍即可}

# 审查清单(仅 full 级别)
1. 功能正确性:实现是否符合任务描述?
2. 边界情况:空输入、异常、并发?
3. 代码质量:可读性、命名、是否有死代码/重复?
4. 安全:注入、权限、敏感信息?
5. 与现有代码风格/架构一致性?
6. 测试覆盖:关键逻辑有没有测试?

# 输出格式(强制)
回复的**第一行**必须是裁决标记之一,后跟对应内容。没有首行裁决标记的回复视为无效,会被打回重审:
- REVIEW_PASS → 一句话总结
- REVIEW_FAIL → 列出每个问题的 {文件}:{行} 和修复建议
- REVIEW_PASS_WITH_NITS → 列出 nits 建议(不阻塞)
```

## Checkpoint 持久化

- **原子写入**:先写临时文件,再 `os.replace()`,防止写一半崩溃导致文件损坏
- **双轮切换**:每次写 checkpoint 时,当前文件 → backup,确保始终有一份完整数据
- **自动触发**:每完成 N 个任务(默认 1,即每个任务都存;可由 pool.checkpoint.write_every 调大)自动保存
- **任务阻塞时立即保存**:失败时立即 checkpoint,不丢失进度

### 恢复流程

1. 启动时检查是否存在 checkpoint
2. 有未完成任务 → **自动恢复,不询问**(run 阶段静默,不向用户提问)
3. 恢复后跳过已完成的任务,继续调度
4. 全部任务完成后自动清理 checkpoint

中断/崩溃后运行 `nightowl resume`(把 checkpoint 里的 pool/state 恢复到磁盘);`next` 会优先返回 checkpoint 里 in_progress 的任务。

## 续跑与中断恢复

- **续跑幂等**:中断在"子代理已 commit、主代理未合并"时,`next` 会用 git 检测出
  该任务的未合入 commit → 输出 `RESUME_MERGE`,续跑直接走"审查→合并→done",
  不重复实现(不会因重跑把同一任务实现两遍)
- **续跑**:所有状态在 `.nightowl/` 目录下。任务池未完成时,下次说"继续上一轮",
  运行 `nightowl status` 找到 pending 任务,接着调度(checkpoint 已恢复状态)
- **推送失败**:commit 都在本地,续跑时可重新 push

## 无人值守驱动(supervise)

run 阶段可脱离交互会话,交给外部驱动引擎 `nightowl supervise` 反复拉起主会话推进任务池:

- **形态**:`nightowl supervise [--interval-sec N] [--timeout-min M] [--max-idle N] [--once]`
  - 默认:循环拉起 `claude -p --continue --dangerously-skip-permissions --append-system-prompt <续跑指令>`
    延续主会话;**任务池全部完成自动退出**;中断后再启动即从断点续(resume 幂等,不重复实现)
  - `--once`:只跑一轮就退出(调试/想分次推进时)
- **每轮主会话做什么**:supervise 每轮注入精简续跑指令,主会话按本技能继续调度循环
  (status → sweep → next → 实现/审查子会话 → verify → done),推进到上下文接近上限或
  本轮可停时自然结束本轮;supervise 用确定性代码判定进度(completed/blocked 变化),再进下一轮
- **续接**:`--continue` 延续最近主会话。首轮无历史会话时 claude 会静默新开会话;
  supervise 在 `--continue` 失败时回退去掉 `--continue` 新开会话
- **韧性**:每轮结束状态已落盘 `.nightowl/`;会话失败自动指数退避重试(retry_budget 次后
  block 该任务);连续无进展达 `--max-idle` 轮停止;单轮超时(`--timeout-min`)强制结束本轮
- **收尾兜底**:业务任务耗尽后,supervise 检查 `.nightowl/nightowl.report.md` 是否已由主会话
  生成(report 是 run 收尾的最后一环);未生成则再拉起一轮收尾轮执行收尾,然后才退出——
  退出即 run 完整结束
- **空转停止 ≠ 任务池完成**:`--max-idle` 连停是保护性停止(无进展防空转),此时池里可能还有
  任务;若实现中的任务(worktree 有未合入 commit)被误停,调大 `--max-idle` 或重跑 supervise
  续跑,不重复实现已完成任务
- **日志**:每轮状态与宿主输出写入 `.nightowl/nightowl.supervisor.log`

## 收尾推送

当没有可执行任务时:

```
0. 先清残留 worktree: `git worktree list` 若不止 main,逐个把未合入的 commit 合回主分支后
   `git worktree remove`,确保收尾时工作区干净
1. 检查是否有"未推送"的 commit:
   git log origin/<branch>..HEAD --oneline
2. 如果有未推送的改动:
   a. 可选:跑一次全量测试(如果时间允许)
   b. git push origin <branch>   # 仅 bypass 下静默 push;非 bypass 不推,留给 plan 阶段处理
   c. 可选:如果是 feature 分支,建 PR(gh pr create)
3. 没有远程仓库:
   - 检测到 git remote 为空 → 跳过推送,在报告里注明"未推送(无远程)"
   - 或者提醒用户配置 remote
4. 推送失败(网络/权限):
   - 不重试超过 2 次
   - 标记 blocked,在报告里注明
```

**推送是"收尾动作",不是每个任务都推** —— plan 阶段攒的往往是一个分支的多任务,run 跑完一起推更合理。推送后,**默认执行 report 生成报告**(下一小节),再交给 `nightowl-report` 向用户汇报。

### 收尾报告(run 默认执行)

**run 收尾的最后一环是 report,不是可选**。推送完成后,直接运行:

```
nightowl --dir <项目根目录> report
```

生成 `.nightowl/nightowl.report.md`(任务总览/阻塞/审查/git 历史),落盘即算完成;
用户在场就当面汇报,离线则回来再看。

## 关键原则

1. **状态外置**:一切进度在文件里,不依赖对话记忆
2. **先分析后动手**:开工先读文档,子代理不盲改
3. **审查独立**:审查子代理不写代码,实现子代理不审自己
4. **测试驱动**:verify 是完成标准,不是可有可无
5. **失败分级**:自动 retry → 耗尽 block → 写状态+报告(不向用户弹通知;状态落盘
   `.nightowl/`,收尾由 report 汇总),不无限重试
6. **worktree 即用即删**:合并回主分支后立即 `git worktree remove` + `git branch -d`,不收尾不清零就不算闭环完成
7. **静默契约**:run 阶段全程不向用户提问、不弹权限确认。开工权限自检要求 bypass
   模式,不满足不开工;收尾 push 仅在 bypass 下执行。一切"通知用户"类操作改为写
   状态文件 + report。plan=交互 / run=静默 / report=收尾默认,边界由三个子技能保证
