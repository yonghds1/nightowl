# 规划：Codex 修复 + 非 Git 多仓根目录调度支持

## 背景（全部有实证）

用户在 `/home/fzyhccg/workspaceOffline`（根目录无 .git，子目录 lcp4/mobile-offline-platform/mydev 各有自己的 .git，sim 无 git）跑 nightowl 调度，暴露四类问题：

1. **codex 缺 `--skip-git-repo-check`** → 首轮 `Not inside a trusted directory` 失败，supervise 把这个启动失败当业务失败计数，2 次后把 M1 误标 blocked（supervisor.log 22:45:57 有实录）。
2. **nightowl 生成的 `.codex/hooks.json` 是 Claude 格式** → codex 0.163.0 报 `unknown field \`PreToolUse\`, expected \`description\` or \`hooks\``。且实测 codex hook 的正确结构是三层：
   - 顶层 `{ "hooks": { "PreToolUse": [MatcherGroup...] } }`
   - MatcherGroup `{ "matcher": "*", "hooks": ["HookEntry"] }`（matcher/enabled 可省）
   - HookEntry `{ "type": "command", "command": "<一条 shell 命令字符串>" }` — **`args` 字段被静默忽略**（实测假 node 脚本收 ARGC=0），必须拼成 `node .codex/hooks/x.mjs` 一条字符串。
   - **信任机制**：不信任时 hook 静默不执行、不报错；`--dangerously-bypass-hook-trust` flag 存在可作为无人值守出口。
3. **codex 容量不足退回 exit=0**（`Selected model is at capacity` 打在 stdout，退出码 0）→ supervise 判"成功但无进展"，走 idle 空转而不是重试。
4. **非 git 根目录下 nightowl 一堆 git 命令误判**（worktree setup 报误导性 "no base commit, empty repo?"、done 误报 noCommit 等）。

用户已确认范围：**多仓根目录调度**（根无 git + 子仓有 git 的混合场景），worktree 隔离在非 git 时**降级为跳过**（agent 直接在主目录实现，协议输出 `WORKTREE_SKIPPED`）。

## 现状事实

- 平台容忍度（实测）：claude 非 git 可跑；codex 需 `--skip-git-repo-check`（exec 与 exec resume 均支持该 flag，已从 codex exec resume --help 确认）；opencode 本机无法验证（登录/国家限制）；antigravity 无 CLI。
- verify 已有 noHead 告警（0.5.1 已修），非 git 下 `ALL_PASS` 仍产出，只是回执缺 head —— 这条已经是期望行为。
- nightowl 用 git 的点：`worktree`(setup/merge/cleanup)、`next`(RESUME_/taskCommitStatus)、`done`(taskCommitInHead 门槛)、`sweep`、`push`、`report`、`verify`(head/dirty)。
- 测试基建：vitest + `runCommand()`（进程内），git 类测试用真 `git init` 临时目录（worktree-stale.test.ts 模式）。
- 本地 workspacekk/nightowl 已同步到 0.5.1（a80b322）。

## 改动清单

### A. codex 平台修复（src/platforms/codex.ts）

**A1. args() 加 `--skip-git-repo-check`**（exec 新起和 resume 续接两条路径都加；flag 放在子命令后、prompt 前）：
```ts
args(prompt, useContinue) {
  if (useContinue) return ['exec', 'resume', '--last', prompt, '--skip-git-repo-check'];
  return ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt];
}
```
同步更新 `nonInteractiveCmd` 提示字符串与 CODEX_TEMPLATE_VARS.PLATFORM_RELAUNCH 文案。

**A2. hooks.json 生成改三层正确结构**（`writePermissions()`）：
```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "node .codex/hooks/permission-mode.mjs" } ] }
    ]
  }
}
```
- 兼容迁移：`commandMatches()` 改为在**两层**任一深度匹配旧/新格式（旧格式是 `{PreToolUse:[{hooks:[...]}]}`, 新是 `{hooks:{PreToolUse:[...]}}`）；老文件（含旧结构）检测到旧结构时整体迁移到新结构（保留用户其它事件键，只把结构搬进去）。
- 幂等：新结构已含我们的命令则不动。

**A3. codex 无信任时 hook 静默不执行**：
- headlessRun args() 补 `--dangerously-bypass-hook-trust`（无人值守 session 本来就是免审批前提，run.md 已声明 bypass 才开工；该 flag 只影响 hook 信任，不放大沙箱权限）。
- 提示文案（selfcheck / init 输出）说明：交互式使用需在 codex 内信任 hook。

### B. supervise 启动失败识别（src/commands/supervise.ts）

**B1. runHostRound 增加输出哨兵**：捕获 stdout+stderr 全文，退出码非 0 或出现协议级基础设施错误特征时归类 `infraError`：
```ts
const INFRA_ERRORS = [
  /Not inside a trusted directory/,        // codex git 检查
  /failed to parse hooks config/,          // codex hooks 配置坏（-nightowl 不再制造这种情况,但用户手误也会卡死调度）
  /insufficient balance/,                  // 余额(已见 claude 端 402)
];
// exit 非 0 且命中哨兵 → infraError=true;业务任务计数跳过。
```
**B2. codex exit=0 但容量不足**：轮结束后扫描输出含 `Selected model is at capacity`（或 `ERROR:.*at capacity`）→ 视为 infraError，退避重试、不空转、不计任务失败。

### C. 非 git 降级（核心：一个统一探测函数）

**C1. 新增 `src/git-info.ts`**（或放 git.ts）：
```ts
export function probeGit(cwd = process.cwd()): { isRepo: boolean; root: string | null } {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  return r.code === 0 && r.stdout.trim() ? { isRepo: true, root: r.stdout.trim() } : { isRepo: false, root: null };
}
```
挂到 `paths.ts` 缓存一次/进程（`.nightowl/.git-info` 不可靠——用户中途 git init 的情况不缓存，每次现查，git rev-parse 毫秒级开销可接受）。

**C2. worktree 命令按 C1 降级**：
- `setup`：`!isRepo` → 输出 `WORKTREE_SKIPPED: 非git仓库,无隔离,在 {项目根} 直接实现`，exit 0（协议 token 注册进 protocol 测试）。
- `merge`：`!isRepo` → 输出 `WORKTREE_MERGE_SKIPPED: 非git仓库`(exit 0)（无分支可合并，跳过即成功语义，流程不断）。
- `cleanup`：`!isRepo` → `WORKTREE_CLEAN_SKIPPED`，exit 0；有 worktree 残留时的清理需求不存在（setup 压根没建过）。
- `list`/`sweep`：`!isRepo` → `WORKTREE_EMPTY` / `SWEEP_CLEAN`（无残留按"干净"语义返回，run.md 流程继续）。

**C3. done 的 commit 门禁加 git 前置**：`taskCommitInHead(id)` 前先 `probeGit`，`!isRepo` 时跳过该门禁（输出一行提示"非git仓库,跳过 commit 校验"），review/verify 两道门照常。`next` 的 RESUME_/taskCommitStatus 同理自然返回 null（git log 失败已容忍，verify 无 head 告警已就位）——只需确认不报错即可。

**C4. push/sweep 对非 git**：非 git 下 push 输出 `PUSH_SKIPPED_NO_REMOTE` 语义已有近似（无 remote 时跳过），但根因是 `git remote` 会失败——按 C1 直接输出 `PUSH_SKIPPED_NO_GIT`（新 token）。

**C5. 任务文档/skills**：run.md 的 worktree 步骤加一行协议说明：`WORKTREE_SKIPPED:` 出现时直接在主目录实现，其余步骤照走（verify→review→done）。SKILL.md 源头改（templates 渲染变量不动，一句话即可）。

### D. 测试

- `test/codex-hooks.test.ts`：hooks.json 生成结构断言（三层正确性 + 迁移旧格式 + 幂等）；mock 一个假 hook 执行不了无需测,结构由实测 schema 锁定。
- `test/nongit.test.ts`：临时目录不 git init → worktree setup/merge/cleanup/list、sweep、push、done(有verify+review) 全走降级路径且 exit 0 / 协议 token 正确；再建子仓库验证混合场景（根无 git + 子仓有 git）。
- `test/supervise-infra.test.ts`：runHostRound 提供 fake 输出（注入 child?不行——改为把"输出哨兵判定"抽成纯函数 `classifyRound(exit, output)` 单测），容量 exit=0 案例走 classifyRound 单测。
- protocol.test.ts 登记：`WORKTREE_SKIPPED:`、`WORKTREE_MERGE_SKIPPED:`、`WORKTREE_CLEAN_SKIPPED:`、`PUSH_SKIPPED_NO_GIT:`
- 全量 npm test 保持绿（当前 391 个）。

### E. 不做的事

- Maven 锁参数（第 4 条）：不改代码，写入 `skills/nightowl-run/SKILL.md` 的 verify 提示一句"Maven 项目若遇 .m2 锁冲突加 `-Daether.syncContext.named.factory=rwlock-local`"——放 skill 而不是 CLI 是因为它是领域知识不是调度能力。
- opencode/antigravity 非 git 行为：无法实测，只加防御性 `--skip-git-repo-check` 等价物为空（opencode 无此 flag），标注待实测。

## 实施顺序

1. C+C2+C3+C5（多仓根目录调度——用户主诉，独立可测）
2. A1+A2+A3（codex 修复）
3. B（supervise 基础设施失败识别）
4. D 测试全家桶 + 全量回归 → commit

## 风险

- hooks.json 迁移可能破坏用户手写 config：迁移时保留所有非 nightowl 事件键，且解析失败（非 JSON）保持现行为（不写不报错）。
- `--dangerously-bypass-hook-trust` 字面带 dangerous：语义只覆盖"hook 信任"，audit 文案里向用户说明；无人值守场景本就要求 bypass。
- classifyRound 的正则可能误伤业务输出里恰好含 "at capacity" 字样：哨兵仅在选择"本轮无进展"分支前用，聊胜于无；误判退避重试的代价低（有空转上限 maxIdle 兜底）。
