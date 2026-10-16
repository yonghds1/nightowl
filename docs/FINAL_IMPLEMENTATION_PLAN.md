# Nightowl 生产级重构终版实施计划书
## (Nightowl Production Implementation Plan: Plan-Boundary & Silent-Run)

> **设计基准**：基于 Nightowl 核心哲学【白天聊透边界，夜间放手无人值守】  
> **制定团队**：Nightowl 架构委员会 (Director 调度 OpenCode 交互架构师与 Codex 执行安全架构师)  
> **核心原则**：
> 1. **白天 (Plan)**：强制自主勘察，禁止拿代码已知事实问用户；通过“依据+方案对比+推荐”一站式聊透边界，双门禁锁死任务池。
> 2. **夜间 (Run)**：Prompt 瘦身至 80 行以内，CLI 全面接管路径与状态；验证回执强绑定代码版本，防假绿灯与偷跑；代码默认保护封存，杜绝死锁与强删。
> 3. **次日 (Report)**：10 秒红绿灯发版决策看板，Git 按任务聚合。

---

## 模块拆解与修改计划对照表

```mermaid
flowchart TD
    subgraph Day_Phase [白天 · 人机协同区]
        Plan[nightowl-plan] --> Plan_Audit[1. 强制自主勘察: 查 context 与源码, 出具勘察依据]
        Plan_Audit --> Plan_Align[2. 架构师式边界对齐: 方案利弊对比 + 一次性拍板清单]
        Plan_Align --> Plan_Lock[3. L1/L2 双门禁锁死: 语法门+单测门, 终审无门禁直接打回]
        Plan_Lock --> Plan_Start[4. 用户输入'开工' ➔ 锁死任务池, 无缝切换夜间静默]
    end

    subgraph Night_Phase [夜间 · 钢铁无人值守区]
        Run[nightowl-run] --> Run_Slim[1. 80行极简 Prompt: 纯粹无人值守心智模型, 消除注意力漂移]
        Run_Slim --> Verify_Lock[2. nightowl verify: 自动寻址 worktrees/id, 失败落盘 feedback.json]
        Verify_Lock --> Receipt_Bind[3. 验证回执强绑定: 记录精确 HEAD SHA + dirty diff hash]
        Receipt_Bind --> Safe_Merge[4. worktree merge: 校验代码版本一致性, 严禁验完偷改合入]
        Safe_Merge --> Safe_Clean[5. worktree cleanup: 默认安全模式保留现场, 显式 discard 才强删]
    end

    subgraph Morning_Phase [次日 · 晨会决策看板]
        Report[nightowl-report] --> Summary[1. Executive Summary: READY / CONDITIONAL / BLOCKED 10秒定发版]
        Summary --> Deviation[2. 工时偏差率统计 + 审查打回警报]
        Deviation --> GitGroup[3. Git log 按任务 [#id] 聚合分组]
    end
```

---

## 详细实施规范

### 一、 白天人机协同区 (Plan & Report)

#### 1. `skills/nightowl-plan/SKILL.md` 重写
- **废除机械审讯**：删除原有“一次只问一题、每题必须给 2-4 个选项”的教条规则。
- **强制先勘察后对话**：
  - 收到需求必须先查 `nightowl analyze` 产出的 `nightowl.context.md`、`package.json`、目标源码与测试配置。
  - 严禁拿代码库已有定论的事实向用户提问。
- **资深架构师式边界对齐**：
  - 遇到业务互斥走向、技术选型或边界盲区，按以下模板一次性呈现：
    > 【勘察依据】已查验 `src/xxx.ts:15` 现有实现为 ...  
    > 【方案对比】方案 A (xxx) 利弊 vs 方案 B (xxx) 利弊  
    > 【推荐路径】推荐方案 B，理由是 ...  
    > 【待拍板清单】B1: ..., B2: ... 请一次性确认。
  - 必须对齐的边界 Checklist：输入输出契约、异常走向、影响范围（动哪些/不准动哪些）、不做什么、成功验收标准。
- **L1/L2 双门禁硬锁池**：
  - `nightowl add` 必须携带至少 2 条验收命令（L1 语法/类型检查 + L2 目标单测）；
  - 终审检查无门禁命令的任务直接打回重拆。

#### 2. `skills/nightowl-report/SKILL.md` 与 `src/commands/report.ts` 升级
- **置顶 Executive Summary（10 秒看板）**：
  - `verdict`：`READY`（可发版）、`CONDITIONAL`（条件发版，如打回次数多或工时超标）、`BLOCKED`（不可发版，有阻塞或 P0 未完）；
  - 工时统计：总预估工时 vs 实际工时，计算偏差比率（如 `+25.0%`）；
  - 审查警报：统计被打回重试的任务与轮次；
  - Git log 变更按 `[#id]` 聚合呈现，过滤掉嘈杂的合并记录。

---

### 二、 夜间无人值守区 (Run & Verify & CLI 底层)

#### 1. `skills/nightowl-run/SKILL.md` 瘦身 (≤ 80 行)
- 仅保留核心无人值守心智模型：
  `权限自检 (bypass) ➔ 获取任务 (next) ➔ 隔离实现 (worktree setup) ➔ 独立门禁 (verify) ➔ 安全合入 (merge) ➔ 安全收尾 (cleanup) ➔ 晨会报告 (report)`。
- 未跟踪文件分类与平台抹平全部由 CLI 内部接管，不占用 Agent 注意力。

#### 2. `skills/nightowl-verify/SKILL.md` 与 `src/commands/verify.ts`
- **单入口寻址**：标准命令 `nightowl verify --id <id>`（自动定位 `worktrees/<id>`，保留 `--cwd` 作为逃生舱）。
- **失败落盘 `feedback.json`**：包含门禁层级、失败命令、退出码、纯净错误诊断提取，指导精准排错。
- **成功版本硬绑定**：扩展 `verify_passed` 结构体：
  ```ts
  export interface VerifyPassed {
    version: 1;
    at: string;
    commands: string[];
    worktree_path: string;
    head: string;             // git rev-parse HEAD 完整 hash
    dirty_diff_hash: string;  // sha256 包含 staged/unstaged/untracked
  }
  ```
- **纯粹退出码判定**：严格依据 `code === 0`，不进行任何破坏性文本正则匹配，杜绝误杀。

#### 3. CLI 底层工程闭环加固
- **`src/task-id.ts` (新增)**：统一校验 `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`，严防 `../` 路径逃逸。
- **`src/commands/worktree.ts`**：
  - `merge`：强校验分支当前 HEAD 与 dirty hash 必须与验证记录完全匹配，验完偷改直接报错阻断；
  - `cleanup`：默认安全模式（未提交改动时拒绝删除并保留目录现场），显式 `--discard` 才允许强删；
  - `setup`：空目录孤儿自动安全自愈，非空孤儿安全阻断。
- **`src/commands/sweep.ts`**：彻底消灭 Git 失败吞错报喜逻辑，非 0 退出统一返回 `SWEEP_FAIL`。

---

## 三、 分步执行排期表

| 阶段 | 实施任务 | 涉及文件 | 验收标准 |
|:---:|---|---|---|
| **Phase 1<br>(底层防线)** | 1. 新增 `src/task-id.ts` 统一 ID 校验<br>2. 加固 `src/commands/sweep.ts` 消除吞错<br>3. 加固 `src/commands/worktree.ts`（防偷改校验、cleanup 安全模式、setup 自愈）<br>4. 升级 `src/commands/verify.ts`（落盘 `feedback.json`、版本哈希绑定） | `src/task-id.ts`<br>`src/commands/sweep.ts`<br>`src/commands/worktree.ts`<br>`src/commands/verify.ts`<br>`src/state.ts` | 单元测试全过：验证旧记录拒绝合并、脏工作区 cleanup 拒绝删除、路径穿越被拦截 |
| **Phase 2<br>(报告看板)** | 1. 升级 `src/commands/report.ts` 支持 Executive Summary 与 Git 聚合<br>2. 补充中英文国际化文本 | `src/commands/report.ts`<br>`src/locales/zh.json`<br>`src/locales/en.json` | 单元测试验证决策判定与工时偏差计算准确 |
| **Phase 3<br>(技能重写)** | 1. 重写 `skills/nightowl-plan/SKILL.md`（自主勘察 + 边界对齐 + 双门禁）<br>2. 重写 `skills/nightowl-run/SKILL.md`（80 行极简静默心智）<br>3. 重写 `skills/nightowl-verify/SKILL.md` 与 `nightowl-report/SKILL.md` | `skills/nightowl-plan/SKILL.md`<br>`skills/nightowl-run/SKILL.md`<br>`skills/nightowl-verify/SKILL.md`<br>`skills/nightowl-report/SKILL.md` | 技能行数达标，无教条问答，全套技能测试通过 |
