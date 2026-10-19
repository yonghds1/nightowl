---
name: nightowl-workflows
description: 分阶段工作流规划:将需求意图或显式原型转换为阶段、角色、依赖与机器门禁。适用于功能、修复、重构、审计；简单独立任务仍用 nightowl-plan。
---

# Nightowl Workflows — 意图到分阶段任务池

## 何时分流

用户需要多阶段交付、明确角色交接或阶段门禁时，由 nightowl-plan 的需求勘察与边界对齐进入本技能。简单独立任务保留 `nightowl add` 路径。
已有方案获批时直接沿用批准边界，不重复询问。只有代码库无法回答且影响交付的决策才沟通：{{PLATFORM_ASK}}。

## 生成方式

```bash
# 中文、英文意图均可；未命中特定类型时默认 feature
nightowl workflow generate --intent "新增登录功能" --no-apply
# 显式模板优先于意图推导；也可单独使用模板
nightowl workflow generate --intent "检查鉴权边界" --template audit --no-apply
nightowl workflow generate --template refactor --no-apply
# 已有声明式 YAML
nightowl workflow generate workflow.yaml --no-apply
nightowl workflow show
nightowl workflow list
```

file 与 `--intent` / `--template` 互斥；空意图、非法模板报错且不修改已保存文件。
不传生成来源时，`nightowl workflow generate` 重新应用已保存工作流；不会自动推导新需求。

## 四大原型与角色

| 原型 | 按序阶段（agent） | 原型门禁 |
| --- | --- | --- |
| feature | design (architect) → implement (developer) → verify (tester) → review (reviewer) | 差异检查 → 类型检查 → 测试 → 差异检查 |
| bugfix | diagnose (debugger) → fix (developer) → regression (tester) → review (reviewer) | 差异检查 → 类型检查 → 回归测试 → 差异检查 |
| refactor | baseline (tester) → refactor (developer) → regression (tester) → review (reviewer) | 基线测试 → 类型检查 → 回归测试 → 差异检查 |
| audit | inspect (auditor) → review (reviewer) → report (auditor) | 差异检查 → 类型检查与测试 → 差异检查 |

意图推导顺序：审计/审查/audit/review/security → audit；修复/故障/bug/fix/debug → bugfix；重构/refactor → refactor；其他 → feature。混合需求以显式模板消歧。
每阶段至少一个任务；阶段依赖编译为上一阶段全部任务的依赖，agent 编译为 assignee，gate_commands 编译合并到每个任务的 verify。角色是逻辑职责，不要求宿主存在同名子代理；使用可用代理承担对应职责，reviewer 必须独立于实现者。

## 执行前落实验收

CLI 产物是可编辑骨架，不是已经完成需求分析的实施计划。默认门禁为 `git diff --check`、`npm run typecheck`、`npm test`；不要假定目标项目具备这些脚本。

1. 按 nightowl-plan 完成实际代码勘察、影响范围与验收对齐；若已完成则复用结论。
2. 使用 `--no-apply` 先保存骨架；编辑 `.nightowl/nightowl.workflow.yaml`，将通用任务拆成具体交付，补充验收标准、估时和项目实际支持的 L1/L2 命令。意图文本只作需求数据，不拼接进 shell 门禁。
3. bugfix 必须先复现与根因定位，并有修复前失败、修复后通过的测试；refactor 必须先记录通过的行为基线并保持外部契约；audit 只读分析与报告，不自动修复。审计门禁也要确认不会改动源码。
4. `git diff --check` 只检查补丁格式，不证明业务正确、审查通过或审计只读；这些验收需明确证据。所有任务必须有适配项目的客观门禁，不能将占位检查当作业务验收。
5. 使用 `nightowl workflow show` / `nightowl workflow list` 核对阶段、角色与依赖；执行 `nightowl workflow generate --apply` 应用已编辑工作流，再用 `nightowl status` 核对任务池。

默认 generate 会替换任务池；`--no-apply` 不读写任务池，也不改独立执行状态。应用保留既有 schedule/checkpoint（除非 YAML 显式覆盖），但不会清空已完成、阻塞或进行中状态。
生成任务 ID 为 `<原型>-<阶段>`，同原型重复生成会复用 ID；如果启动新一轮交付，先明确现有执行状态并为新任务设置唯一 ID，不能无声清空状态或把旧任务当作新任务执行。

完成审批后交给 nightowl-run 使用现有调度器、验证与完成门禁，结束时使用 nightowl-report；本技能不另建执行引擎，也不自动启动代理或执行门禁。
