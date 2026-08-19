---
name: nightowl-report
description: run 收尾后生成 nightowl.report.md,汇总完成/阻塞任务与 git 提交推送,并处理报告疑问。用户问"run 干了什么""报告呢",或收尾需出报告时使用。
---

# Nightowl Report — run 后出报告

**report 是 run 收尾的默认动作,不是可选交回** —— run 调度结束(任务全做完)后,
主代理直接运行下面的 report 命令生成报告并落盘,再在用户在场时当面汇报。
把本次 run 的成果整理成报告给用户看。

## 生成报告

收尾后运行:

```
nightowl --dir <项目根目录> report
```

生成 `.nightowl/nightowl.report.md`,包含:
- 任务总览表(每个任务:优先级/估值/实际用时/状态)
- 阻塞任务及原因
- 最近 git 历史(最近的 commit)

报告生成后自动清理/更新 checkpoint(全部完成则清理,否则保存最终 checkpoint)。

> **技能版本落后提示**:`nightowl status` 若提示"项目技能 vX < 当前包 vY",本次 run
> 收尾时顺手重跑一次 `nightowl init --skip-permissions` 重铺(幂等,不动任务池),
> 避免下轮 run 用旧版技能。

## 向用户汇报

用户回到对话后,主动把本次 run 的结果讲清楚:

```
本次 run 完成了 T1、T2、T3。T4 留给下一轮 run。
git log:
  a1b2c3 feat: utils 模块
  d4e5f6 test: 单元测试
```

汇报要点:
- 本次 run 分析了什么文档
- 完成 / 审查通过的任务清单
- 被审查打回 / 阻塞的任务(附原因)
- git 提交 + 推送情况
- 后续建议

## 处理用户对报告的操作

用户看完报告后的典型诉求:

| 用户说 | 做 |
|--------|-----|
| "继续上一轮 run" | `nightowl status` 找 pending,接 `nightowl-run` 续跑 |
| "T3 重新拆一下" | 拆成更细的任务(回 `nightowl-plan`) |
| "T3 跳过" | `nightowl block T3 "用户跳过"` 或改任务池 |
| "T3 我手动改" | 把任务从池里移除或标记,交回用户 |
| "T3 改成 P2" | 调优先级 |
| "今天到这,别派新任务" | 停止派新任务,收尾交 report |

## 对账

报告跟 git log 对不上时,以 git 为准对账:
- 看 `.nightowl/nightowl.report.md` 和 `nightowl.log`
- `git log --oneline -20` 核对实际提交
- `git worktree list` 确认无残留 worktree
- 报告状态与任务池以 `.nightowl/nightowl.state.yaml` 为准

## 故障排查

完整命令清单看 `nightowl --help`(每个子技能只列自己用到的命令,不再各放一份速查表)。常见问题:

| 现象 | 处理 |
|------|------|
| 没看到报告 | 看 `.nightowl/nightowl.report.md` 和 `nightowl.log` |
| 子代理卡住很久 | 说"卡哪了?",检查子代理状态 |
| 报告跟 git log 对不上 | 说"报告不对",对账 |
| 想全手动 | 说"今天我自己来",只帮写命令 |
| 中途断了想恢复 | 说"继续上一轮",自动从 checkpoint 恢复 |
| 频繁弹权限确认 | 首次运行 `nightowl setup-permissions`;run 会话按平台以无权限确认模式启动(Claude `claude --dangerously-skip-permissions`;Codex `codex exec --full-auto`) |
| checkpoint 损坏 | 删除 `.nightowl/checkpoint.yaml*` 重新开始 |
