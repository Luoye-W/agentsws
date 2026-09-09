# @agentsws/txn

交易控制模块（31 §1 I8：契约 #3 审批 + #4 账本 + #5 执行器合并为一个事务边界）。

```ts
const { approvals, ledger, executor } = createTxn({ clock, random, eventSink, store })
```

- **审批总线**（规范 14）：create → 预检（provenance / 收件人门禁 / 围栏 / 密钥扫描 / 语义 diff）→ 额度判定 →
  auto_approved 或路由；dedupe_key 重复提交更新原项并使旧 decision_token 失效；decide 校验
  token 绑定 (item_id, revision, execution_snapshot.hash)、recipients 权限与 SoD；escalate / expire / 批量决定。
- **变更账本**（规范 15）：stage 跑 core.evaluateGuardrail，block 不建项；(assignment, kind, day)
  额度预占，apply 成功转实、失败或过期释放；累计与频次统计包含 applied + 在途 + 预占。
- **执行器**（规范 15 §5）：八步含步骤 0 幂等；重读记录比对 record_version；重跑 guardrail；
  重算执行快照；三态结果 applied / failed / unknown（unknown 走 reconcile）；同目标同 kind 串行；
  批准后取消窗口；父子顺序（回信必须在子退款 applied 之后）。

存储接口 `TxnStore` 两档：默认 `MemoryTxnStore`（测试与 fast 档模拟），落盘用 `SqliteTxnStore`（WP18，同一份契约一致性套件两档各跑一遍）；时间经 `Clock`、随机经注入、
事件按 `EventEnvelope` 形状交给 `eventSink`（不依赖 kernel 包）。`staged_action` v1 关闭。
