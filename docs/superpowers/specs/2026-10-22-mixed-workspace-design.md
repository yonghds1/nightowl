# 混合工作区 plan/run 修复规格

日期：2026-10-22
状态：详细规格已获用户确认（2026-10-22），按此实施
基线：0.6.0 / 3c12414

## 目标与批准范围

根目录没有 Git，下面混有多个 Git 仓库与普通目录时，使用根目录的统一 `.nightowl/` 完成 plan/run。沿用既有降级设计：任务串行、直接修改原目录，跳过根目录 worktree、merge、cleanup、push。单仓库保留当前隔离流程。不能把跳过操作宣称为隔离、合并、提交或推送成功。

用户已确认的模块图：

| 模块 id | 职责 | 依赖 |
| --- | --- | --- |
| workspace-context | 根目录类型、受限目录发现、项目路径与构建测试线索 | 无 |
| workspace-preflight | 按工作区类型检查初始化与 Git 风险 | workspace-context |
| execution-lifecycle | 修复提交诊断、定义串行降级路径与收尾 | workspace-context、workspace-preflight |
| skill-contracts | 统一技能、命令模板、文档及端到端回归 | 以上三项 |

实施顺序同依赖方向。四项共同交付一个能力：现有混合工作区降级流程可正确执行；本轮不建立独立的多仓隔离子系统。

## 已核实问题

- `src/commands/preflight.ts` 将非 Git 根目录直接判 fail，和既有降级冲突。
- `src/commands/analyze.ts` 只读取当前目录的清单，不能看到子项目。
- `src/commands/commit.ts` 将非仓库错误报为 detached HEAD。
- `skills/nightowl-run/SKILL.md` 无条件进入 worktree、提交，和命令模板的跳过规则冲突。
- `test/nongit.test.ts` 未覆盖强制 preflight 和真实子仓库提交，现有全链路测试名大于实际覆盖范围。

## 工作区与目录契约

1. 所有调度命令从用户选择的工作区根目录执行，CLI 现有 `nightowl --dir <root> <command>` 仍通过 chdir 定位根目录。
2. Git 操作遵循调用目录；`.nightowl/` 仍向祖先查找。进入子仓库只用于该仓库提交等明确操作，随后返回根目录进行 verify/review/done。不能用 `--dir <root>` 一边定位任务池、一边假设仍操作子仓库。
3. 新建共享 `src/workspace.ts`，提供纯读取的类型识别和发现接口，供 analyze/preflight 共用。结果含绝对根目录、`single-repo | mixed | plain` 类型、子仓库和子项目相对路径、扫描不完整或探测失败诊断。
4. Git 根目录判断必须依据 Git 命令结果，兼容 `.git` 目录和 linked worktree 的 `.git` 文件。根目录处于已有仓库内时仍保留现有 Git 模式，不改写仓库拓扑。
5. 非 Git 根目录递归发现子项目；固定最大深度 4、最多访问 1000 个目录。跳过所有隐藏目录及 `node_modules`、`vendor`、`dist`、`build`、`coverage`、`target`、`venv`、`__pycache__`。不遍历目录符号链接、不越出工作区；输出稳定排序。遇到 Git 仓库后停止向其内部继续发现仓库，避免扫描仓库实现树。仓库内的嵌套独立仓库不属于本轮自动发现范围。
6. 有构建清单或 README 的目录作为子项目，直接子普通目录也列出；包装目录可以继续遍历。构建线索复用 analyze 的清单提取规则。
7. 到达扫描上限必须明确给出诊断。`analyze` 可输出不完整上下文；`preflight` 必须 fail，避免在不完整仓库清单上放行。扫描失败、不存在或不可访问路径必须携带路径，不能静默忽略。

## 命令与错误契约

### analyze

`nightowl --dir <root> analyze` 保留原根项目上下文，并追加工作区类型、仓库路径和各子项目的测试/构建线索。写入同一 `.nightowl/nightowl.context.md`。不初始化 Git，不修改业务配置。空白目录输出 plain 类型，不能伪造构建命令。

### preflight

`nightowl --dir <root> preflight`：

- `.nightowl/` 未初始化仍 fail。
- 非 Git 根目录本身不再 fail，不再建议根目录 `git init`。
- 为保守覆盖未知任务影响范围，首版检查发现的全部子仓库；任务级仓库筛选不在本轮范围内。
- 各子仓库检查分支、提交身份、进行中的 merge/rebase/cherry-pick/revert、HEAD 是否存在、Git 状态命令是否成功。detached、缺身份、未完成操作、空仓无 HEAD 或命令失败均 fail，并附仓库路径。
- 脏工作区、浅克隆、残留 worktree、缺 remote 沿用 warn；`--strict` 将这些 warn 升级为 fail。run 不接管已有脏改动，应 block 受影响任务，不自动 stash/reset。
- 非 Git 降级能力说明作为信息展示，不是 warn；否则纯非 Git 目录会在 strict 下永远无法使用。子仓库不要求无关的根 `.nightowl/` 忽略规则；只有位于该仓库内的状态目录才检查忽略。
- Git 未安装、超时、权限不足、损坏的 `.git` 或探测失败必须 fail。仅明确的“不是 Git 仓库”允许降级，不将所有非零结果归为非仓库。
- 保留 `PREFLIGHT_OK` 和 `PREFLIGHT_FAIL: <n>` 协议，混合工作区输出明确仓库路径，不依赖外部平台实际启动。

### commit

`cd <root>/<repo> && nightowl commit --task <id> -m "..." --all` 只提交当前仓库，复用祖先任务池；一次任务涉及多个仓库时分别提交。先准确识别 not-repo、Git 故障和 detached，再执行原有门禁。保留 `COMMIT_FAIL`、`COMMIT_OK <hash>`。根目录无 Git 时明确提示进入目标子仓库；普通目录不伪造提交成功。既有子仓库未提交改动不交由代理一并提交，实际 run 只暂存任务相关文件。

### run 生命周期与版本限制

- 保留 selfcheck 权限门槛。
- 单仓库继续 setup → 实现提交 → verify → review → merge → cleanup → done。
- 非 Git 根：next → setup 返回 `WORKTREE_SKIPPED` → 在原目录串行实现 → 对 Git 子仓库分别提交本任务文件 → 返回根 verify → review → merge/cleanup 返回各自 SKIPPED → done。
- 所有 verify 命令明确子目录，如 `cd repo-a && npm test`；普通目录用自身构建或检查命令。验收失败必须修复或 block，禁止跳过。
- 根目录 verify 无统一 HEAD 时沿用现有无 head 回执及明确告警，不声称拥有跨仓库版本绑定；没有新任务字段或新回执格式。单仓库现有版本门禁保留。
- 非 Git 根 done 的提交门禁保持既有降级语义。技能要求在完成前检查每个相关子仓库提交状态，但不声称 CLI 已机器验证所有仓库提交。
- 根 push 仍输出 `PUSH_SKIPPED_NO_GIT`；输出说明子仓库尚未由该命令推送。只有任务或用户明确约定了推送才对相关仓库分别执行，不自动遍历推送所有仓库。
- 保留 `WORKTREE_SKIPPED`、`WORKTREE_MERGE_SKIPPED`、`WORKTREE_CLEAN_SKIPPED`、`SWEEP_CLEAN` 等既有协议值。

## 代码与文件组织

源代码 `src/`，命令 `src/commands/`，中英文本 `src/locales/{zh,en}.json`，测试 `test/*.test.ts`，技能 `skills/`，平台命令模板 `templates/commands/nightowl/`，文档 `docs/` 和 README。

使用 TypeScript strict、NodeNext、ESM `.js` 导入，2 空格缩进，单引号。复用 `git()`、`gitEnv()`、`gitFailure()` 和状态锁。Git 必须使用参数数组调用，不能拼接路径到 shell；已有 verify 用户命令仍走 runShell。

```ts
import { git } from './git.js';

const result = git(['rev-parse', '--show-toplevel'], { cwd: projectRoot });
if (result.code === 0) {
  return result.stdout.trim();
}
```

故障分支必须显式分类，不能只靠上述成功示例推断所有失败均可降级。新增 Git 探测接口应保留现有 `probeGit` 调用方兼容性或同步验证其失败处理，不改变未知调用方协议。

## 验收与测试

使用 Vitest、真实临时 Git 仓库与 CLI 子进程；mock 仅用于 Git 不可执行、超时等不可稳定制造的故障。不启动真实平台代理，不联网推送。

| 场景 | 必须结果 |
| --- | --- |
| 普通单仓库 | 原 worktree 生命周期、版本门禁和提交门禁通过，无回归 |
| 两个正常 Git 子仓库 + 普通目录，根无 Git | analyze 发现项目；preflight 通过；root commit 准确失败；分别提交子仓；全部验收后 done |
| 纯非 Git 目录 | 初始化后 preflight 通过，含 strict；Git 类命令按约定跳过；真实验收和 review 后完成 |
| 子仓 detached / 无身份 / 未完成 merge / 空仓 | preflight 拒绝，并包含对应子仓路径与原因 |
| Git 不可执行 / 损坏 / 不可访问 | fail，不得当成无 Git 自动放行 |
| 脏子仓或无 remote | 默认 warn；strict fail；不修改用户已有改动 |
| 验收失败 | 记录 feedback，done 被阻断，无假完成 |
| 名称含空格的子仓 | Git 检查和提交路径正确；示例验收命令正确引用路径 |
| 符号链接与扫描上限 | 不越界、不循环；上限触发时 preflight fail |
| 技能与命令模板 | plan 明确逐项目验收；run 明确跳过分支和串行语义；无相互矛盾规则 |

检查命令：

```bash
npm run typecheck
node node_modules/vitest/vitest.mjs run test/nongit.test.ts test/preflight.test.ts test/commit-command.test.ts test/verify-head.test.ts
npm run check
```

新增 workspace 和混合生命周期测试随全量测试执行。另用已构建 `bin/nightowl.js` 在临时混合目录重演用户调用路径，覆盖 CLI 的 `--dir` 和真实 cwd 行为。测试后清理临时目录，检查仓库 diff，不运行发布流程。

## 边界

- 必须：保留既有机器协议和单仓行为；补中英文文案；同步技能及模板；先有失败回归再修复；运行全量检查；明确降级保障限制。
- 需要额外确认：跨仓隔离 worktree、新任务 schema、多仓版本快照、实际业务仓库推送、增加依赖或改变 CI。
- 禁止：初始化根 Git、自动 stash/reset 用户改动、自动提交用户原有脏文件、自动修复业务仓库身份或 remote、静默跳过 Git 故障、将跳过声明为推送成功。

## 未决项

无阻塞性的业务问题。扫描上限、全量子仓预检、空仓 fail 和无多仓版本快照是本规格明确的实现边界；用户如需更改这些边界，应在编码前修订规格。


## 实现与验证记录

- 新增 `src/workspace.ts` 复用目录发现；`src/git.ts` 严格区分非仓库与基础设施故障，操作状态探测支持显式 cwd。
- `analyze` 逐项目收集上下文；`preflight` 逐仓检查并附路径；`commit` 准确提示非仓库；`push` 明示未推送子仓。
- 同步 plan/run/verify/report 技能及命令模板、中英文 README；修复文档检查误读 quoted verify 参数的问题。
- 新增 `test/workspace.test.ts`、`test/workspace-failures.test.ts`、`test/mixed-workspace.test.ts`、`test/mixed-cli.test.ts`；覆盖真实混合工作区生命周期、普通目录、路径空格、Git 故障、损坏仓库、权限和扫描上限。
- `npm run check`：类型检查、构建及 49 个测试文件共 502 项通过。CLI 子进程实景包含 root --dir 调度、子仓祖先状态查找、真实提交、验收、报告；不联网推送、不启动真实模型代理。
- 保留限制：根目录降级仍无隔离、跨仓回滚或统一版本绑定，done 不机器核验全部子仓提交。扫描最多 4 层和 1000 目录，遇仓库不继续发现其内部仓库。
- 未提交、未发布；全局安装仍是原包，需显式使用本项目构建后入口或另行更新安装。
