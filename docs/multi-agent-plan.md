# Nightowl 多 Agent 平台移植规划

> 2026-09-08 制定。业务核心（任务池/state/checkpoint/报告）宿主无关，`src/platforms/` 已有 `Platform` 抽象；
> 本规划覆盖：Codex 补完（P0）、OpenCode（P1）、Antigravity（P2）、打磨（P3）。
> 所有平台机制均按官方文档核实（文末来源列表），但 **codex / opencode / antigravity 本机无 CLI，交付前需真实环境实测**。

## 一、现状

- `platforms/types.ts` 定义 4 个宿主相关能力：铺装模板 / 写权限 / bypass 检测 / headless 启动。
- `claude.ts` 完整；`codex.ts` 实验性（注释自认未验证，且与现行官方文档有出入）；opencode / antigravity 缺失。
- 技能内容（`skills/*/SKILL.md`）按 Claude Code 机制编写：
  - run：调度循环写死 `Agent 工具 + subagent_type="general-purpose" + mode="bypassPermissions" + isolation="worktree"`；
  - plan：提问规范写死 `AskUserQuestion` 工具；
  - 多处文案 "Claude xxx / Codex yyy"。

### Codex 现有实现与官方文档的出入（P0 修正）

1. **技能路径**：官方扫描 `.agents/skills/`（CWD 逐级向上到 repo root + `~/.agents/skills`），不是 `.codex/skills/`。
2. **`--full-auto` 已废弃**：改为 `codex exec --sandbox workspace-write`（静默配合 config `approval_policy="never"`）。
3. **`headlessRun` 未实现**：补 `codex exec "<prompt>"` / `codex exec resume --last "<prompt>"`。
4. **sandbox 网络**：`workspace-write` 默认禁网 → `git push` 会失败；config 需 `[sandbox_workspace_write] network_access = true`。
5. **项目受信**：项目级 `.codex/config.toml` / hooks 仅在项目 trusted 时加载，文档需提示。

## 二、平台机制对比（2026-09 核实）

| 能力 | Claude Code | Codex | OpenCode | Antigravity |
|------|------------|-------|----------|-------------|
| 项目技能目录 | `.claude/skills/` | `.agents/skills/` | `.opencode/skills/`，兼容读 `.claude/` 与 `.agents/` | `.agents/skills/`（兼容 `.agent/`） |
| 子代理 | Agent 工具，内置 `isolation="worktree"` | 自然语言/skill 指令委派；`.codex/agents/*.toml`；**无 worktree 托管** | 内置 `general`（task 工具/@）；`.opencode/agent/*.md`；无托管 | `.agents/agents/*.md`（`subagent: true`），`invoke_subagent`；无托管 |
| 静默权限 | `--dangerously-skip-permissions` + settings.json 白名单 | `approval_policy="never"` + `sandbox_mode`；`--yolo`/danger-full-access | `opencode.json` permission 规则 或 `--auto` | 全局 `~/.gemini/antigravity-cli/settings.json` allow 规则；`--dangerously-skip-permissions` |
| hook 权限模式检测 | PreToolUse stdin `permission_mode` | 同左，枚举一致（`default/acceptEdits/plan/dontAsk/bypassPermissions`）→ 共用脚本 | **无文件式 hook**（TS 插件 `tool.execute.before`） | `.agents/hooks.json` PreToolUse 但 stdin 无 `permission_mode` 字段 |
| headless | `claude -p --continue` | `codex exec` / `exec resume --last` | `opencode run [--continue] --auto` | `agy -p [--continue]`，stdout 回复/stderr 诊断 |
| 结构化提问 | AskUserQuestion | 无（纯文本） | 无 | 无选项式工具 |

**关键红利**：`.agents/skills/` 是 Codex/OpenCode/Antigravity 共享标准 → 铺一份覆盖三家。
**关键风险**：Antigravity headless 未授权动作是 **soft-deny**（跳过继续、exit 0），不显式报错 → 该平台自检必须强制 bypass。

## 三、设计决策

- **D1 技能内容多宿主化**：主体宿主无关 + `init` 安装时渲染平台附录（`{{PLATFORM_*}}` 占位）。
  不做每平台全量拷贝（防漂移），不做运行时自探分支（模型读文本做分支不可靠）。
  实现：`Platform.templateVars(projectRoot)` 提供 `{{PLATFORM_SELF_CHECK}}` / `{{PLATFORM_DISPATCH}}` / `{{PLATFORM_NONINTERACTIVE}}`；
  `installFile` 增可选 `transform`（渲染 + hash 对渲染产物计算，本地定制检测逻辑不变）。
  注：附录注入技能源文本身（宿主无关占位），三家宿主通用；不注入 AGENTS.md（会污染非 nightowl 会话）。
- **D2 子代理策略**：Claude 维持 Agent 工具托管 worktree；其余三家调度循环改为
  "主代理 Bash `git worktree add` → 委派子代理时在 prompt 显式指定工作目录 → 回收合并即删"。
- **D3 自检降级链**：hook 文件 → 进程 cmdline → unknown 引导按平台命令无交互重启。
- **D4 Codex push**：`writePermissions` 合并 `[sandbox_workspace_write] network_access = true`（需 TOML table 段级合并，行级 mergeTomlKey 不够）。

## 四、分期

### P0 Codex 补完 + 抽象升级
- `types.ts`：`Platform` 增 `templateVars(projectRoot)`。
- `install.ts`：`installFile` 增 `transform`。
- `codex.ts`：技能路径 `.agents/skills`；headlessRun；`nonInteractiveCmd` 去 `--full-auto`；
  config.toml 补 network_access；detectBypass 多特征匹配。
- SKILL.md 三份抽象化 + 附录占位。
- i18n/init 文案泛化；测试更新。

### P1 OpenCode
- `opencode.ts`：skills 走 `.agents/skills`；写 `.opencode/opencode.json` permission 规则（allow 白名单映射）；
  headlessRun `['run','--auto',...(continue?['-c']:[]),prompt]`；detectBypass 扫 ps cmdline `--auto`。
- 附录：内置 `general` subagent + task 工具委派；worktree 手动管理。

### P2 Antigravity
- `antigravity.ts`：skills `.agents/skills`；权限写**全局** settings.json（无项目级，`scope=project` 需降级处理/文档说明）；
  headlessRun `['-p',prompt,'--dangerously-skip-permissions',...(continue?['--continue']:[])]`；
  铺 `.agents/agents/nightowl-implementer.md` / `nightowl-reviewer.md`。
- 附录重点：soft-deny 防御 + 强制 bypass 自检。

### P3 收尾
- README 平台矩阵；`status` 显示平台；CI 冒烟（可选）。

## 四点五、执行状态（2026-09-08 实施）

P0 / P1 / P2 已落地，`npm test` 163 用例全绿，四平台 `init` CLI 冒烟均通过（渲染产物无 `{{PLATFORM_*}}` 残留）。相对原计划的实现调整：

- **D1 落地形态**：未采用"文末附录"，改为正文内嵌 `{{PLATFORM_ASK / RELAUNCH / HEADLESS / SUBAGENT_D / SUBAGENT_CALL / SUBAGENT_DIR / PUSH_MODE}}` 占位 + 每平台 `templateVars()` 渲染；`installFile` 增可选 `transform`，hash 对渲染产物计算，本地定制检测不变。见 `src/platforms/render.ts`。
- **P1 OpenCode detectBypass**：原计划"扫 ps `--auto`"不可靠（无稳定 PID env），改为**读项目 `opencode.json` 的 `permission.bash==="allow"`** 判静默（`detectBypassFor(cwd)`，init 后即可判 true）。
- **P2 Antigravity detectBypass**：读全局 `settings.json` 是否含 `command(nightowl)` allow，兜底再扫 `ps` 找 `agy ... --dangerously-skip-permissions`；测试经 `AGY_SETTINGS_FILE` 注入，不污染真实 HOME。

**未验证项（需真实环境）**：codex / opencode / antigravity 的 headless 续接语义、子代理是否严守 worktree 约束、Codex 项目受信后 config 生效、Antigravity soft-deny 行为——均按文档实现，标注 🧪。

## 五、来源

- Codex: developers.openai.com/codex/skills · learn.chatgpt.com/docs/{non-interactive-mode,hooks,agent-configuration/subagents,config-file/config-basic,environments/git-worktrees}.md
- OpenCode: opencode.ai/docs/{skills,agents,permissions,cli,plugins}
- Antigravity: antigravity.google/docs/{skills,cli/headless/,cli/permissions/,cli/subagents/,hooks/}
