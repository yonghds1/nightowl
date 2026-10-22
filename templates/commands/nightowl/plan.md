# Nightowl Plan

进入 plan 阶段：读取 `nightowl-plan` 技能，交互式对齐需求并拆成任务池。

## 流程

1. **初始化(首次)**:任务池不存在时先初始化
   ```
   nightowl init -u <你的名字>
   ```
   身份已写入 `.nightowl/.developer` 后可省略 `-u`。已初始化则跳过。
2. **分析项目上下文**:`nightowl analyze` 生成 `.nightowl/nightowl.context.md`(技术栈/入口/测试命令/CI),拆任务时对齐模块、文件、验收命令都有依据。
3. **拆任务(对话式)**:先勘察，再集中对齐代码中无法推断的业务与技术决策。单任务 15-60 分钟,大了拆、小了并。一个任务 = 一份 PRD。
   ```
   nightowl add --id T1 --title "..." --priority P0 --est-min 15 \
     --desc "..." --acceptance "..." --verify "npm test"
   ```
4. **用户审核**:`nightowl status` 列出任务,逐条确认 title/acceptance/est-min。
5. 用户确认后进入 run 阶段:`/nightowl:run`。

## 原则

- plan=交互 / run=静默:需求澄清、颗粒度、优先级、权限获取都在 plan 完成,run 阶段不补交互。
- 权限已由 `init` 按平台写入(Claude → `.claude/settings.json`;Codex → `.codex/config.toml`)。

## 混合工作区

根目录无 Git、下面混有 Git 仓库与普通目录时，无需初始化根 Git。`nightowl analyze` 列出子项目和工作区类型；发现最多 4 层、1000 个目录，跳过隐藏、依赖和构建目录，不跟随目录符号链接，也不继续遍历仓库内部；扫描不完整时不能直接开工。

任务描述/PRD 明确各目标路径、逐仓提交要求及推送授权。所有验收从工作区根目录执行，使用 `--verify 'cd "repo a" && npm test'` 这类明确路径的命令，普通目录也有实际检查。混合模式原目录串行修改，无跨仓隔离、统一版本绑定或跨仓自动回滚。开工前 `nightowl preflight` 检查发现的全部子仓库，真实风险必须处理。
