---
name: nightowl-plan
description: 交互式把大需求拆成任务池的子技能(init 初始化+申请权限 / add 加任务 / status 看池子)。用户描述想做的功能、要求拆/加/改任务、看任务池,或首次初始化配权限时使用。
---

# Nightowl Plan — 交互式规划任务

run 能不能静默高效跑,取决于任务池拆得清不清楚。这个技能在 plan 阶段负责把用户的大需求拆成可执行的任务清单(全程交互)。

## 工作流程

### 1. 初始化(首次)

如果项目还没有任务池,先初始化。`init` 是**项目级初始化**:创建任务池文件、自动申请全部权限、并把技能铺进项目(进 git,clone 后即用):

```
nightowl init -u <你的名字>
```

- `-u <你的名字>`:写入开发者身份到 `.nightowl/.developer`(本地文件)。身份已写入后可省略。
- `--platform <claude|codex>`:目标 agent 平台,默认 claude(已 init 过则读 `.nightowl/.platform`);`--claude`/`--codex` 为快捷别名。

在项目根目录的 `.nightowl/` 下生成 `nightowl.tasks.yaml`、`nightowl.state.yaml`、`nightowl.log`;权限与技能按平台写入:Claude → `.claude/`(settings.json 权限白名单 + skills),Codex → `.codex/`(config.toml 静默权限 + hooks.json + skills)。plan `add`/`status`/run 调度不再弹权限确认。

任务池已存在时 `init` 跳过创建、仍补齐权限与模板(幂等);只想对本机生效(不提交 git)用 `--scope local`;不想要权限改动用 `--skip-permissions`;被本地定制的技能文件默认跳过,`--force` 覆盖。

**技能按项目 `init` 部署,只认项目 `.claude/skills/`**,不依赖全局 `~/.claude/skills/nightowl-*`(全局那份已退场,混用会版本漂移)。npm 包升级后技能可能落后于 CLI:`nightowl status` 会提示"项目技能 vX < 当前包 vY",此时重跑一次 `nightowl init` 即重铺为当前版本(`--force` 可覆盖被本地定制的文件)。

### 2. 分析项目上下文

拆任务前先分析项目,让 run 阶段实现子代理有项目上下文(技术栈/入口/测试命令/CI/关键目录):

```
nightowl analyze
```

输出结构化 `# 项目上下文` 块并落盘到 `.nightowl/nightowl.context.md`。这是 plan 阶段"分析需求"的基础 —— 拆任务时对齐模块、文件、测试命令都有依据,不是凭空猜。已存在则刷新。

### 3. 拆任务(对话式)

**不要听到需求就直接 add**。先和用户对话澄清细节、对齐颗粒度,一次一题(参考 trellis-brainstorm,每条给推荐答案):

**2.1 澄清大需求范围** — 用 AskUserQuestion 一次问一个问题,逐项对齐:
- 这个需求解决什么问题、要什么结果
- 涉及哪些模块/文件
- 边界:明确不做什么

**2.2 拆成 15-60 分钟的任务**:
- 单任务颗粒度 **15-60 分钟**;超过 60 分钟拆成多个任务;低于 15 分钟的小改动合并进相关任务
- **一个任务 = 一份 PRD**,`add` 自动生成 `prd.md`(见下方"任务 PRD 文档")

**2.3 逐个任务对齐颗粒度** — 每个任务 add 前,用 AskUserQuestion 确认(给推荐答案):
- title 是否准确
- 验收标准(acceptance)是否可勾选
- `est-min` 预估是否合适

**2.4 确认清单** — 全部 add 完,`status` 列出任务,和用户最后确认一遍颗粒度/优先级,再进入下一环节。

确认后,用 `add` 写入任务池(示例命令仅为格式展示;**verify 等实施命令必须按项目实际技术栈写** —— 以第 2 步 analyze 产出的 `.nightowl/nightowl.context.md` / package.json / README 为准,不要照搬示例;写不清命令就先读上下文,别默认套用某个技术栈):

```
nightowl add \
  --id T1 --title "加 string_reverse 函数" \
  --priority P0 --est-min 15 \
  --desc "在 src/utils.ts 中添加 string_reverse 函数,支持 ASCII 字符串" \
  --acceptance "函数签名 export function string_reverse(s: string): string;空字符串返回空字符串" \
  --depends-on T0 \
  --verify "npm test"
```

每个任务字段:

| 字段 | 必填 | 说明 |
|------|------|------|
| `--id` | ✅ | 唯一标识(T1/T2/...) |
| `--title` | ✅ | 摘要,一行说清做什么 |
| `--priority` | ✅ | P0 必做 / P1 重要 / P2 可选 |
| `--est-min` | ✅ | 预估分钟数,只作记录(不用于调度判断) |
| `--desc` | | 详细描述,帮子代理理解 |
| `--acceptance` | | 验收标准,写清楚怎么算完成 |
| `--depends-on` | | 依赖的任务 id,可多个 |
| `--verify` | | 验收命令,可多条(完成闭环用它判通过) |
| `--assignee` | | 负责人名(默认读 `.developer`,无则 `nightowl-user`);也决定任务目录归属层 |
| `--slug` | | PRD 文档 slug(默认取 ASCII title;中文 title 回退用任务 id) |

### 任务 PRD 文档

`add` 会为每个任务自动生成一份 PRD 文档,替代单纯几行描述:

```
.nightowl/tasks/
├── yonghds1/                 # 负责人(assignee)层,保留中文名
│   └── 08-11-add-reverse/    # 命名 = 时间 + 任务描述(slug)
│       └── prd.md            # 详细需求文档
└── nightowl-user/            # 未初始化时默认负责人
```

- 文档路径 = `tasks/<assignee>/MM-DD-<slug>/prd.md`,按负责人分层;slug 取 `--slug` 或 ASCII title,中文 title 自动回退用任务 id(如 `yonghds1/08-11-T1`)。
- 模板预填 **Goal / Requirements / Acceptance Criteria**(acceptance 按 `;` 拆成 checklist、verify 逐条转命令清单);**Technical Notes / Implementation Record** 留空待填。
- **plan 阶段充实文档**:用 trellis-brainstorm 或系统 plan 模式深挖需求后,把技术细节、涉及文件、约束写进 `Technical Notes`,验收细化为可勾选 checklist。run 阶段 `next` 调度会输出 `PRD_PATH`,实现子代理先读这份文档再动手。
- 任务 `done` 后 prd.md 保留,作为该任务的实现记录归档。

### 4. 用户审核

`add` 完让用户看任务列表,逐条确认 title / description / acceptance / verify 无误,**颗粒度大小合适**(单个任务应在 15-60 分钟区间,大了拆、小了并):

```
nightowl status
```

### 5. 确认开工

用户审核通过后,说"OK,开工",任务池就绪,进入 run 阶段由 `nightowl-run` 接手(全程静默,收尾默认出报告)。

## plan=交互 / run=静默 / report=收尾默认

**plan 阶段可以、也必须和用户交互** —— 需求澄清、颗粒度确认、优先级对齐、权限获取
都在这个阶段完成。`init`/`setup-permissions` 已把 run 阶段要用的命令写进白名单,
这就是"权限在 plan 阶段拿全"。**run 阶段全程静默**:不向用户提问、不弹权限确认,一切进度落盘 `.nightowl/`;
run 收尾默认执行 report 生成报告。所以 plan 阶段把需求问清、把权限拿全,
run 阶段才能安静跑完 —— 三个阶段的边界是 nightowl 的前提,别在 run 阶段补交互。

## 首次使用:配权限

`init` 已自动申请权限,**首次直接跑 init 即可**。若只想补权限(不重建任务池),可单独运行:

```
nightowl setup-permissions
```

只想对本机生效(不提交 git):加 `--scope local`。

## 直接改文件

用户随时可以手动编辑 `nightowl.tasks.yaml`,代理会尊重改动:
- 加/删任务
- 改优先级
- 改验收命令

## 任务粒度建议

- 单任务 **15-60 分钟**能完成为宜,避免单次 run 拖太长、中断后续跑麻烦;超过 60 分钟拆成多个任务,低于 15 分钟合并
- **一个任务 = 一份 PRD**,拆任务时和用户逐个对齐颗粒度,别一次堆一堆
- title 是摘要,description 写清楚做什么,acceptance 写清楚怎么算完成
- P0 任务优先调度,别堆太多 P2
