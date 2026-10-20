# Nightowl Plan

进入 plan 阶段:交互式分析需求并拆成任务池。此阶段可以和用户交互。

## 流程

1. **初始化(首次)**:任务池不存在时先初始化
   ```
   nightowl init -u <你的名字>
   ```
   身份已写入 `.nightowl/.developer` 后可省略 `-u`。已初始化则跳过。
2. **分析项目上下文**:`nightowl analyze` 生成 `.nightowl/nightowl.context.md`(技术栈/入口/测试命令/CI),拆任务时对齐模块、文件、验收命令都有依据。
3. **拆任务(对话式)**:先和用户对话澄清需求、对齐颗粒度,一次一题,给推荐答案。单任务 15-60 分钟,大了拆、小了并。一个任务 = 一份 PRD。
   ```
   nightowl add --id T1 --title "..." --priority P0 --est-min 15 \
     --desc "..." --acceptance "..." --verify "npm test"
   ```
4. **用户审核**:`nightowl status` 列出任务,逐条确认 title/acceptance/est-min。
5. 用户确认后进入 run 阶段:`/nightowl:run`。

## 原则

- plan=交互 / run=静默:需求澄清、颗粒度、优先级、权限获取都在 plan 完成,run 阶段不补交互。
- 权限已由 `init` 按平台写入(Claude → `.claude/settings.json`;Codex → `.codex/config.toml`)。
