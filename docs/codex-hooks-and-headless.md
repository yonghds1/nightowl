# Codex hooks 配置与无人值守启动参数（实测 )
codex-cli 0.163.0,`@openai/codex` npm 包,本机 2026-10-21 实测。
本页同时是 nightowl Codex 平台支持的依据:hooks schema 的每个字段、headless 启动参数、hook 信任的绕过方式均经真实 codex 验证。

## 1. hooks.json 正确 schema(codex 0.163.0,与 Claude settings.json 完全不同)

顶层是 `hooks` 表(放 `description` 也可以);事件名通过 `hooks.<事件名>` 访问。
事件可忽略大小写(实测 PreToolUse/PostToolUse/... 均是 openai/codex hooks crate 支持的枚举值)。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .codex/hooks/permission-mode.mjs"
          }
        ]
      }
    ]
  }
}
```

三层结构逐层解析:
| 层 | 名称 | 字段 |
|---|---|---|
| 顶层 | `HooksToml` | `description` / `hooks`(实测 serde 报错文案:`unknown field \`PreToolUse\`, expected \`description\` or \`hooks\``) |
| 事件表 | `HookEventsToml` | 任意事件名 → `MatcherGroup[]` |
| matcher 组 | `MatcherGroup` | `matcher` / `hooks`(enabled 可选;字段未知不报错, `matcher` 可省略) |
| hook 条目 | — | `type: "command"` + `command: "一条 shell 命令字符串"` |

### 常见错误(每一条都踩过)

1. **顶层直接放 `PreToolUse`(Claude settings.json 风格)** → 启动报
   `unknown field \`PreToolUse\`, expected \`description\` or \`hooks\``,hook 全部不生效。
2. **`args` 字段会被静默忽略**。Claude 风 `{ "command": "node", "args": ["script.mjs"] }` 在 codex 里
   实际执行的是 `node`(不带参数)。必须把参数拼成一条 shell 字符串:`"node .codex/hooks/x.mjs"`。
   (实测:写假 node 记录 argv,args 形式收到 ARGC=0,字符串形式收到 ARGC=2。)
3. **hook 不报错但从不执行** —— 默认没有信任(见下)。

## 2. PreToolUse hook 的输入(std JSON,与 Claude 基本一致)

stdin 收到 JSON,含 `permission_mode`(枚举与 Claude 一致):
`hook_event_name` / `permission_mode` / `tool_name` / `tool_input` / `session_id`。
nightowl 用它实现「往 `.nightowl/.permission-mode` 记录当前权限模式」的自检,
Claude 与 codex 共用同一个 `permission-mode.mjs` 脚本。

## 3. hook 信任(最隐蔽的坑)

**hooks 只解析还不够——不信任就静默不执行,且不报任何错。**
信任态持久化在本地(`~/.codex` 下;源码显示为 `hooks.state` 相关, sqlite)。
交互式(TUI)运行 codex 时会弹信任确认;但 headless/exec 无法交互。

3 种通路的实测矩阵:

| 通路 | 结果 |
|---|---|
| `codex exec --yolo`(= `--dangerously-bypass-approvals-and-sandbox`,no approvals + 无沙箱) | **不豁免 hook 信任**。审批/沙箱/hook 信任是三道独立的门,`--yolo` 只覆盖前两道 |
| config 键 `-c 'bypass_hook_trust=true'` | **明确无效**,启动即提示 `session-flags: \`bypass_hook_trust\` is ignored` |
| 命令行 flag `--dangerously-bypass-hook-trust` | ✅ 生效。hook 执行且 exit 0(实测多轮) |

> 名字里带 dangerous 是因为 hook 会以会话身份跑任意命令;
> 无人值守场景(本身要求 bypass)用它是合理组合,但不要在交互/不可信环境滥用。

### 配置范例(nightowl 自动生成)

nightowl init 时写入三件套:
1. `.codex/config.toml`:`approval_policy="never"` + `sandbox_mode="workspace-write"` + `[sandbox_workspace_write] network_access=true`
2. `.codex/hooks.json`:如上三层结构
3. `.codex/hooks/permission-mode.mjs`:权限模式记录脚本

无人值守一条命令(全部必要参数):

```bash
codex exec --skip-git-repo-check --sandbox workspace-write --dangerously-bypass-hook-trust "<prompt>"
```

续接上次会话:

```bash
codex exec resume --last "<prompt>" --skip-git-repo-check --dangerously-bypass-hook-trust
```

完全免沙箱(不推荐,等价 `--yolo`):

```bash
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust "<prompt>"
```

逐参数说明(nightowl headlessRun 自动注入,无需手动):

| 参数 | 必要性 | 说明 |
|---|---|---|
| `--skip-git-repo-check` | **必须** | 任务根可能不是 git 仓库(多仓父目录);缺则启动直接失败 `Not inside a trusted directory and --skip-git-repo-check was not specified` |
| `--sandbox workspace-write` | 推荐 | 文件写入只限工作区;配 config.toml 的 `sandbox_mode` 更稳(命令行优先) |
| `--dangerously-bypass-hook-trust` | **必须**(若要用 hooks) | headless 无法交互信任;缺它 hook 静默不执行且不报错。只豁免信任,不放大沙箱 |
| `approval_policy = "never"`(config.toml) | 推荐 | 免审批(config 层);如果命全面发展,交互 TUI 也受限——紧急退出仍是 Ctrl+C |
| `--dangerously-bypass-approvals-and-sandbox` / `--yolo` | 可选升级 | 同时免审批+无沙箱;文件系统不再受限。hook 信任仍需独立 flag |

## 4. 模型容量(SOL 服务端)实测

```bash
codex exec -m gpt-6.1-sol "say ok"   # "ERROR: Selected model is at capacity" → exit 0 !
codex exec -m gpt-6-luna "say ok"    # 正常
```

**坑:容量不足时 codex 退出码是 0**,脚本/调度器只看 exit code 会误判成功。
nightowl 的 supervise 对这种情况按输出内容识别(`Selected model is at capacity`),
按 infra 错误处理(退避重试,不空转,不计任务失败)。自研对接 codex 的脚本务必同时判断输出内容。

## 5. 无人值守驱动(nightowl supervise 视角)

nightowl `codex` 平台 `headlessRun` 注入的 args 终版(0.4.3 起):

```
[ exec, --skip-git-repo-check, --sandbox, workspace-write, --dangerously-bypass-hook-trust, <prompt> ]
[ exec, resume, --last, <prompt>, --skip-git-repo-check, --dangerously-bypass-hook-trust ]
```

实测确认(本机 codex-cli 0.163.0):
- `nightowl init --codex` 生成的 hooks.json 被 codex 解析通过(无 warning)
- hook 真实执行(`hook: PreToolUse Completed`),`.nightowl/.permission-mode` 被写下 `bypassPermissions`
- 调度首轮在非 git 根目录可正常启动(`--skip-git-repo-check` 生效)
