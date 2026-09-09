# @agentsws/simulation

模拟回路（09 §3、26）：场景 DSL + 合成公司生成器 + runner + 六条不变量 + 报告与合并门禁。

```
# fast：每次提交跑的合并门禁
agentsws simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42 --report out/
# realistic：真模型（有 key 才跑，没 key 整档跳过），花费按预算硬停
agentsws simulate --tier realistic --pack packs/dtc-3c-3p --max-cost-base 2 --report out/
# soak：同一个世界连着过 N 天（题目由 pack 的到达率生成，不按 glob 选）
agentsws simulate --tier soak --pack packs/dtc-3c-3p --days 3 --report out/
agentsws synth --size 3 | 15 | 50 --seed 42
agentsws replay <run_id> --db <events.db>
```

- **场景 DSL**（26 §1）：`state + events[] + expected`，扩展虚拟时钟、合成人策略、不变量。
  解析只认已声明的键——场景是回归题，静默忽略一个拼错的键等于静默关掉一条断言。
  事件：`inbound.email` / `actor.decide` / `clock.advance` / `inject.fault` / `model.outage` /
  `inject.budget` / `routine.start` / `learning.start` / `reconcile.run` / `process.restart`；
  `$last_outbound_draft`、`$last_staged_change`、`$thread` 在运行中解析。
  场景级的 `policy` 能压小升级 / 过期时限与抽检比例（**改配置不改语义**：默认仍是 14 里那套
  24 / 48 工作小时、10% 抽检），`tiers` 声明这条题只在哪几档跑。
- **世界装配**（`world.ts`）：内核事件日志、数据层、职责与策略层、知识、模型网关、交易控制模块
  **全部是真实实现**；只有 provider（mock OpenConnector）、模型（stub）、人（合成人）、时钟、
  投递、入站是替身。这是"模拟里跑的就是生产内核"的前提（09 §3.1）。
- **六条不变量**（`invariants.ts`）：`no_write_without_stage`、`apply_only_after_approved`、
  `provenance_respected`、`fencing_covers_external`、`prompt_replayable`、`freeze_on_model_outage`。
  每条只读**事件日志与出站观察**——"能从日志证明"本身就是要证明的东西。
- **三档**（26 §4）：`fast`（stub，分钟级）/ `realistic`（真模型 + 来信缓存 + 预算，`realistic.ts`）/
  `soak`（连着 N 天 + 随机故障 + 关库再开，`soak.ts`——它把 N 天摊成一条场景交给同一个执行器跑，
  所以六条不变量与指标一个都不用重写）。
- **judge**（`judge.ts`，26 §1）：规则 judge 确定性、每档都跑、**进门禁**；模型 judge 只在有真模型时跑、
  **只报不拦**。评分标准放在 pack 的 `judge/*.md`：frontmatter 给规则 judge，正文给模型 judge。
- **每一拍的审批总线例行公事**（`world.tickApprovals()`）：过期、升级链、抽检复核。
  真实进程里这是定时任务；虚拟时间里不每拍走一遍，"没人理就升级"永远不会发生。
- **指标**（`metrics.ts`）：每个指标都带它的事件查询（类型 + 条数），26 §6.4 要求可追溯。
- **门禁**（`report.ts`）：fast 全过 + 指标不劣化（默认 5%，方向按指标定义）。

边界（31 §1 I9）：这里只做**协议不变量**那一类。平台契约冒烟（真实测试店）、真实模型质量评测、
独立隐藏恶意输入是另外三类，不在这个包里，也不互相代替。**替身跑通不等于上线可靠。**
验收题在 `hidden/`，不随 pack 发布。
