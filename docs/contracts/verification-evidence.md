# 验收、审查、完成与报告证据契约

适用范围：现有 verify/review/done/report 链路的可靠性修复。不引入任务作用域、多仓版本快照或执行隔离。

## 触发与故障

旧行为：成功验收留下 `verify_passed`，后一次失败只写 feedback，旧记录仍可让 done 完成并让报告显示可发版。审查记录也没有绑定具体验收轮次。

正确行为：每次验收先作废旧通过证据，只有当前成功轮次和对应审查才能正常完成有门禁的任务。

## 签名与字段

共享模块 `src/evidence.ts`：

```ts
type EvidenceStatus = 'valid' | 'missing' | 'invalid';
verificationEvidence(task: Task): EvidenceStatus;
reviewEvidence(task: Task): EvidenceStatus;
beginVerification(taskId: string, commands: string[]): string | null;
finishVerification(taskId: string, runId: string,
  receipt?: VerifyPassed, onCurrent?: () => void): boolean;
failIntegrationEvidence(taskId: string, runId: string | undefined): void;
```

`src/state.ts` 增加向后可读的可选字段：

```yaml
verification_run:
  id: <独立 UUID>
  status: running # 或 passed / failed
  at: <ISO 时间>
  commands: [node gate.cjs]
verify_passed:
  run_id: <同一 UUID>
  at: <ISO 时间>
  commands: [node gate.cjs]
  # head 和 dirty_diff_hash 沿用原可选语义
review:
  verify_run_id: <同一 UUID>
  result: PASS
  level: full
  note: ''
  at: <ISO 时间>
```

## 状态与写入约束

1. begin 在存储锁内核对最新命令快照，写入 running，删除旧 verify_passed，然后才能执行用户命令。
2. finish 比较当前 run id、running 状态和命令快照。不匹配轮次不写状态、不修改 feedback。命令中途改变时将当前轮次标 failed，不发出 ALL_PASS。
3. feedback 写入或清理与当前轮次检查同处存储更新回调中，旧进程不得删除新轮次诊断；反馈使用原子写入。
4. PASS 审查绑定当前有效成功轮次。新验收保留旧审查作历史依据，但旧绑定不能放行新轮次。重新审查沿用已有 review_history。
5. done 同时核对命令快照、最新轮次、成功回执和审查绑定，事务内写任务完成前再次核对。即便 state 已有完成记录，再次 done 也不能掩盖新失败。`--force` 保留显式旁路，不会生成验收或审查证据。
6. worktree merge 在有门禁时要求有效验收证据；合并后复验失败撤销源回执并保留现有回滚逻辑。复验成功不另建轮次，原审查仍指向已验证的源轮次。
7. 旧格式回执仍能读取，但没有轮次链接的有门禁任务必须重新 verify 再 review，不能凭历史存在性完成。无门禁旧任务仍保留 review-only 完成兼容性，但报告不认为具有客观验收证据。
8. 复用既有存储锁；不新增工作区独占锁。既有锁超时无锁降级策略不在本轮更改范围内，因此本功能不是恶意/强并发写入的完整事务隔离保证。

## 命令与输出

```bash
nightowl verify --id T1
nightowl review T1 --result PASS
nightowl done T1
nightowl report
```

保留 ALL_PASS、VERIFY_NONE、VERIFY_RECORD_STALE 等现有机器协议。失败仍 exit 1。字段和判定共享，不为各命令复制不同的“有效”规则。

## 验证与错误矩阵

| 场景 | done | report |
| --- | --- | --- |
| 当前验收通过，审查绑定同轮，所有任务完成 | 放行 | 任务证据通过；生产发版待核实 |
| 曾通过但最近失败 | 拒绝 | BLOCKED |
| 新轮次正在执行或进程中断留在 running | 拒绝 | BLOCKED |
| 成功重跑但审查仍指向前轮 | 拒绝 | BLOCKED |
| 验收命令改变或运行中改变 | 拒绝 | 不得全绿 |
| 旧回执缺轮次，或强制完成但证据不足 | 拒绝正常完成 | 缺少证据时 CONDITIONAL，不伪造通过 |
| 已完成后重新验收失败 | 再次调用也拒绝 | BLOCKED，历史完成记录保留 |
| 尚有 P1 待办，即便 P0 全完成 | 不适用 | 不得 READY |
| 旧进程比新轮次更晚返回 | 不覆盖新证据 | 依据最新轮次 |
| 合并后复验失败 | 撤销回执，拒绝完成 | BLOCKED |

报告 `READY` 内部枚举保留，文案改为“任务证据通过，发版待核实”，明确判定只基于任务记录；不核实生产部署、推送或全部子仓版本。

## Good / Base / Bad

- Good：verify 成功 → review 绑定该轮 → done；命令及轮次均一致。
- Base：加载历史任务，不补造轮次；执行 verify + review 后恢复正常流程。
- Bad：verify 成功 → review → verify 失败 → done；必须失败，报告不得全绿。

错误：`if (task.verify_passed) allowDone()`。
正确：`verificationEvidence(task) === 'valid' && reviewEvidence(task) === 'valid'`（无门禁任务的兼容行为见上文）。

## 必需测试与断言

- `test/verification-evidence.test.ts`：成功后失败无旧回执、命令变化、重跑后重审、历史回执、强制完成、待办、运行中、轮次交错和中途命令变更。
- `test/evidence-cli.test.ts`：构建后 CLI 重演原漏洞、恢复路径、已完成后失败、报告明确不是发版授权。
- `test/worktree-recheck.test.ts`：失败复验撤销源回执，未经重新验收的合并重试被拦截。
- `test/report-executive.test.ts`：READY 测试提供真实结构的当前轮次与审查绑定，不仅伪造 completed。
- `test/scheduler.test.ts`：verify 在 review 之前；复用旧审查不放行。

验证命令：`npm run check`。不启动真实平台模型、不推送业务仓库。

## 非目标与已知限制

本轮核验命令列表、执行轮次和审查关联，不创建全目录内容哈希。因此无法自动识别未重新验收的普通目录文件变化，也不声称检测所有子仓的 HEAD 变化。单仓保留原 merge HEAD 校验。更强版本/内容绑定属于后续已讨论但未纳入的作用域与快照能力。


## 本轮验证记录

2026-10-22：`npm run check` 通过，含类型检查、构建、51 个测试文件和 515 项测试。新增 13 项回归包括 CLI 漏洞复现与恢复、已完成后失败、并发轮次、命令中途改变、反馈发布失败保守阻断；既有单仓与混合工作区回归通过。代码未提交、未发布，未更新全局安装。
