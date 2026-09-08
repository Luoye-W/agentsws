# @agentsws/simulation

模拟回路（09 §3、26）：场景 DSL + 合成公司生成器 + runner + 六条不变量 + 报告与合并门禁。

```
agentsws simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42 --report out/
agentsws synth --pack dtc-3c --people 3 --orders 50 --seed 42 --out packs/dtc-3c-3p
agentsws replay <run_id> --db <events.db>
```

- **场景 DSL**（26 §1）：`state + events[] + expected`，扩展虚拟时钟、合成人策略、不变量。
  解析只认已声明的键——场景是回归题，静默忽略一个拼错的键等于静默关掉一条断言。
  事件：`inbound.email` / `actor.decide` / `clock.advance` / `inject.fault` / `model.outage` /
  `inject.budget`；`$last_outbound_draft`、`$last_staged_change`、`$thread` 在运行中解析。
- **世界装配**（`world.ts`）：内核事件日志、数据层、职责与策略层、知识、模型网关、交易控制模块
  **全部是真实实现**；只有 provider（mock OpenConnector）、模型（stub）、人（合成人）、时钟、
  投递、入站是替身。这是"模拟里跑的就是生产内核"的前提（09 §3.1）。
- **六条不变量**（`invariants.ts`）：`no_write_without_stage`、`apply_only_after_approved`、
  `provenance_respected`、`fencing_covers_external`、`prompt_replayable`、`freeze_on_model_outage`。
  每条只读**事件日志与出站观察**——"能从日志证明"本身就是要证明的东西。
- **指标**（`metrics.ts`）：每个指标都带它的事件查询（类型 + 条数），26 §6.4 要求可追溯。
- **门禁**（`report.ts`）：fast 全过 + 指标不劣化（默认 5%，方向按指标定义）。

边界（31 §1 I9）：这里只做**协议不变量**那一类。平台契约冒烟（真实测试店）、真实模型质量评测、
独立隐藏恶意输入是另外三类，不在这个包里，也不互相代替。**替身跑通不等于上线可靠。**
验收题在 `hidden/`，不随 pack 发布。
