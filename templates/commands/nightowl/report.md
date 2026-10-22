# Nightowl Report

生成 run 收尾报告并当面汇报。

## 流程

1. 生成报告:`.nightowl/nightowl.report.md`
   ```
   nightowl report
   ```
   汇总:任务总览(完成/阻塞)、审查过程、git 提交与推送情况、后续建议。
2. 向用户当面汇报:完成哪些任务、阻塞哪些、git 状态、下一步建议。
3. 处理用户疑问:对账、跳过、调整优先级、手动修复。

## 说明

- `report` 是 run 收尾的默认动作,不是可选交回。
- 全部任务完成时 `report` 自动清理 checkpoint。
- 仅已授权推送的任务才执行推送。单仓库可用 `nightowl push`；无 Git 根返回 `PUSH_SKIPPED_NO_GIT` 时没有推送子仓，须按任务约定逐仓处理。
- 混合工作区原目录串行执行，无跨仓隔离或统一版本绑定；逐仓核实提交/推送后汇报，不把 Git 操作跳过宣称为完成。
