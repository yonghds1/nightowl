---
name: nightowl-plan
description: 交互式把大需求拆成任务池的子技能(init 初始化+申请权限 / add 加任务 / status 看池子)。用户描述想做的功能、要求拆/加/改任务、看任务池,或首次初始化配权限时使用。
---

# Nightowl Plan - 交互式规划任务

run 能不能静默高效跑,取决于任务池拆得清不清楚。这个技能在 plan 阶段负责把用户的大需求**审讯清楚**再拆成可执行的任务清单(全程交互):需求没问透就拆任务,run 阶段的实现子代理只能猜着写。

## 工作流程

### 1. 初始化(首次)

如果项目还没有任务池,先初始化。`init` 是**项目级初始化**:创建任务池文件、自动申请全部权限、并把技能铺进项目(进 git,clone 后即用):

```
nightowl init -u <你的名字>
```

- `-u <你的名字>`:写入开发者身份到 `.nightowl/.developer`(本地文件)。身份已写入后可省略。
- `--platform <claude|codex>`:目标 agent 平台,默认 claude(已 init 过则读 `.nightowl/.platform`);`--claude`/`--codex` 为快捷别名。

在项目根目录的 `.nightowl/` 下生成 `nightowl.tasks.yaml`、`nightowl.state.yaml`、`nightowl.log`;权限与技能按平台写入:Claude -> `.claude/`(settings.json 权限白名单 + skills),Codex -> `.codex/`(config.toml 静默权限 + hooks.json + skills)。plan `add`/`status`/run 调度不再弹权限确认。

任务池已存在时 `init` 跳过创建、仍补齐权限与模板(幂等);只想对本机生效(不提交 git)用 `--scope local`;不想要权限改动用 `--skip-permissions`;被本地定制的技能文件默认跳过,`--force` 覆盖。

**技能按项目 `init` 部署,只认项目 `.claude/skills/`**,不依赖全局 `~/.claude/skills/nightowl-*`(全局那份已退场,混用会版本漂移)。npm 包升级后技能可能落后于 CLI:`nightowl status` 会提示"项目技能 vX < 当前包 vY",此时重跑一次 `nightowl init` 即重铺为当前版本(`--force` 可覆盖被本地定制的文件)。

### 2. 分析项目上下文

拆任务前先分析项目,让 run 阶段实现子代理有项目上下文(技术栈/入口/测试命令/CI/关键目录):

```
nightowl analyze
```

输出结构化 `# 项目上下文` 块并落盘到 `.nightowl/nightowl.context.md`。这是 plan 阶段"分析需求"的基础 -- 拆任务时对齐模块、文件、测试命令都有依据,不是凭空猜。已存在则刷新。

**代码库能回答的,自己查,不问用户**:技术栈、测试命令、已有模块结构这类问题,答案是现成的(analyze 产物 / package.json / README),探索代替提问。审讯环节的每一题都留给代码库里查不到的决策。

### 3. 需求审讯

**不要听到需求就直接 add**。把需求当决策树:根 = 要什么结果;分支 = 每个待定决策。逐分支拷问,按依赖顺序解决 -- 先定方案层(做什么),再定边界层(不做什么),再定实现层(怎么做);决策之间有依赖时逐个解决,不跳步(方案没定就问实现细节是白问)。

**提问规范(每一题都必须遵守)**:

1. 用 AskUserQuestion 工具提问,绝不用纯文本提问
2. 一次只问一题,等用户回答再问下一题
3. 每题 2-4 个具体选项,选项 = 真实可选方向(泛泛的"是/否"不算合格选项),推荐项放第一个并在描述里给推荐理由
4. 代码库/文档能回答的,自己探索,不占用户一题
5. 每次回答后用 1-2 句确认敲定的决策,立即问下一题,不闲聊

**审讯终点**:对着决策树自检"还有哪个决策没定?"-- 问不出新决策才算完成,不是把固定清单过完就停。典型要敲定的分支:

- 需求解决什么问题、成功的判断标准
- 涉及哪些模块/文件,动哪些、不动哪些
- 边界:明确不做什么
- 方案分歧点:有多种实现路线时的取舍(性能/复杂度/兼容性)

审讯敲定的决策是终审"决策总结"的素材,也是拆任务和写 acceptance 的依据。

### 4. 拆任务

审讯把决策定了,拆任务就是把决策翻译成任务清单:

- 单任务颗粒度 **15-60 分钟**;超过 60 分钟拆成多个任务;低于 15 分钟的小改动合并进相关任务
- **一个任务 = 一份 PRD**,`add` 自动生成 `prd.md`(见下方"任务 PRD 文档")

**依赖设计(预防 run 阶段死锁)**:

- 公共基础(类型定义/工具函数/接口契约)拆成独立任务先行,被依赖的任务标 P0
- `depends_on` 只表达"真前置"(B 必须等 A 合并才能开工),能并行的不设依赖
- 避免循环依赖;依赖链深不超过 3

**优先级分配**:P0 = 核心链路缺它不可 / P1 = 重要增强 / P2 = 可选优化,别堆 P2。

**verify 设计(run 的测试关口完全依赖它)**:

- 必须包含**针对新功能**的测试命令,不是只跑存量 `npm test` -- 新功能没有测试覆盖,run 的测试关口形同虚设
- 多条时按"快 -> 慢"排(先单测后构建),失败能快速定位

用 `add` 写入任务池(示例命令仅为格式展示;**verify 等实施命令必须按项目实际技术栈写** -- 以第 2 步 analyze 产出的 `.nightowl/nightowl.context.md` / package.json / README 为准,不要照搬示例;写不清命令就先读上下文,别默认套用某个技术栈):

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
- **plan 阶段充实文档**:把审讯敲定的技术细节、涉及文件、约束写进 `Technical Notes`,验收细化为可勾选 checklist。run 阶段 `next` 调度会输出 `PRD_PATH`,实现子代理先读这份文档再动手。
- 任务 `done` 后 prd.md 保留,作为该任务的实现记录归档。

### 5. 终审

全部 add 完,一次确认(不再分"颗粒度确认"和"任务审核"两轮),输出两部分:

1. **决策总结**:审讯环节敲定的所有决策,一行一条,用户 10 秒能扫完
2. 运行 `nightowl status` 列出任务清单

用户对两者一次过确认:title 准确 / acceptance 可勾选 / est-min 合适 / 依赖与优先级无误 / verify 覆盖新功能。有异议:改完(直接改 `nightowl.tasks.yaml` 或调整后重 add)再过一遍终审。

### 6. 开工前置检查

用户说"开工"时,先把 run 阶段的自检失败前置到 plan -- 三项检查全过才移交 nightowl-run,用户说开工就真的能开工:

1. **工作区干净**:`git status` 已跟踪文件有未提交修改 -> 先让用户提交或 stash,不带半成品开工(未跟踪文件不阻断,分类规则见 nightowl-run)
2. **权限模式**:运行 `nightowl selfcheck`,输出非 `PERMISSION_MODE: bypass` -> 告知按平台以无权限确认模式重启会话(Claude `claude --dangerously-skip-permissions`,Codex `codex exec --full-auto`),否则 run 阶段会弹权限确认,破坏静默
3. **任务池就绪**:`nightowl status` 正常展示任务清单

三项全过,任务池移交 run 阶段由 `nightowl-run` 接手(全程静默,收尾默认出报告)。

## plan=交互 / run=静默 / report=收尾默认

**plan 阶段可以、也必须和用户交互** -- 需求审讯、颗粒度确认、优先级对齐、权限获取
都在这个阶段完成。`init`/`setup-permissions` 已把 run 阶段要用的命令写进白名单,
这就是"权限在 plan 阶段拿全"。**run 阶段全程静默**:不向用户提问、不弹权限确认,一切进度落盘 `.nightowl/`;
run 收尾默认执行 report 生成报告。所以 plan 阶段把需求问清、把权限拿全,
run 阶段才能安静跑完 -- 三个阶段的边界是 nightowl 的前提,别在 run 阶段补交互。

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
- **一个任务 = 一份 PRD**,颗粒度纪律靠 15-60 分钟区间保证,终审一次对齐
- title 是摘要,description 写清楚做什么,acceptance 写清楚怎么算完成
- P0 任务优先调度,别堆太多 P2
