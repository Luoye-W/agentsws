# 变更账本与 Guardrail 规范 v1（契约 #4）

| | |
|---|---|
| 日期 | 2026-09-08 |
| 对应 | 03 §2.3；Commerce Agents `merchant_agent/changes.py`（ChangeLedger + guardrails）、`gates.py`（provenance、record-read）；05 §1.3 Mandate；14 §3 `staged_change` |
| 原则 | ① Backend 里不存在"直接改"的方法：写只能 stage，只有 `apply_change` 真写 ② Agent 提议、人（或额度）施行，审计字段天然分离 ③ apply 时重跑全部规则 ④ 只能对本次运行见过的实体动手 ⑤ 拆单不能绕过额度 |
| 存放 | 账本在共享数据层，每次状态变化是事件；账本是 `staged_change` 审批项的真源 |

---

## 0. 对象关系

```
RunRequest ──▶ 运行中 Backend.stage_*() ──▶ StagedChange（status=staged）──▶ 审批项 staged_change
                    │ 读处理器写入                                         │ 通过 / 额度内
             ProvenanceState（seen_*）                                     ▼
                                                    approved_change_ids ◀── 宿主写入
                                                             │
                                          执行器 apply_change(id) ──重跑 Guardrail──▶ applied | failed
```

---

## 1. StagedChange

```ts
type StagedChange = {
  id: string                                 // 'chg_…'，也是 apply 的 Idempotency-Key
  schema_version: 1
  workspace_id: string
  role_id: string
  assignment_id: string                      // 决定额度与等级
  run_id: string                             // 提议它的运行；apply 时凭它反查 provenance
  change_set_id: string                      // 同一次运行里的一组变更（§4）

  kind: ChangeKind                           // §2 目录
  target: ObjectRef                          // { type: 'order' | 'product' | 'discount' | 'theme' | 'campaign' | 'ad_set' | 'repo_pr' | …, id }
  field?: string                             // 改哪个字段（price / shipping_address / budget …）
  before: unknown                            // 取自 stage 时读到的记录（不是模型说的）
  after: unknown
  record_version?: string                    // stage 时目标记录的版本 / updated_at，apply 时比对（§5）

  money?: {                                  // 涉钱的变更必填
    amount: number; currency: string
    amount_base: number; base_currency: string; fx_rate: number; fx_at: string   // 换算到工作区基准货币，快照
    margin_before_pct?: number; margin_after_pct?: number
  }

  guardrail: GuardrailResult                 // stage 时的评估（§3）
  guardrail_rerun?: GuardrailResult          // apply 时的重跑
  notes: string[]                            // 模型写的说明（不参与判定）

  created_by: { kind: 'agent' | 'person'; id: string }
  status: 'staged' | 'approved' | 'auto_approved' | 'applying' | 'applied' | 'unknown' | 'failed' | 'expired' | 'withdrawn' | 'superseded' | 'reversed'
  risk_class: 'low' | 'medium' | 'high'      // 09-08 新增（31 §3.4）；v1 只有 low 可自动
  reservation?: { counter: string; amount: number; released?: boolean }   // 额度预占（31 §3.2）
  execution_snapshot?: ExecutionSnapshot     // 批准时冻结（14 §4）
  approval?: { item_id: string; by: person_id | 'mandate'; at: string }
  apply?: {
    by_executor: string; at: string
    idempotency_key: string                  // = id
    execution_id?: string                    // OpenConnector 的
    outcome_ref?: ObjectRef                  // 退款 id / 新价格记录 / 已发布主题 id / 合并 commit
    error?: { code: 'stale_record' | 'guardrail' | 'provider_error' | 'policy_tightened' | 'not_approved'; message: string; retryable: boolean }
  }
  reversal_of?: string                       // 这是对某个已 applied 变更的反向变更
  expires_at: string                         // 跟随审批项（默认 7 天，对外草稿子变更 48h）
  created_at: string; updated_at: string
}
```

字段纪律：`before` 必须来自 stage 时的读（provenance 里有记录），不是模型转述；`after` 由模型提议但经 schema 校验（金额是数字、货币是 ISO 码）；`notes` 只给人看。

---

## 2. ChangeKind 目录（v1）与默认额度

默认值来自 04 文档，都是占位，公司在策略层改。金额一律按工作区基准货币比较。

| kind | target | 可自动的上限 | 默认 caps | 硬约束（违反即 block） |
|---|---|---|---|---|
| `refund` | order | L2 | `max_auto_refund_amount: 50`；`within_policy_window_only: true`；`window: 20/day` | 不可超过订单实付；同一订单 `no_repeat_target_field` |
| `reship` | order | L2 | `max_items_per_order: 1`；`window: 10/day` | 仅已付款订单 |
| `address_change` | order | L2 | `unfulfilled_only: true` | `protected: [total, currency, customer_id]` |
| `discount_code` | discount | L2 | `max_presales_discount_pct: 10`；单码单客单次 | 不可叠加已有码 |
| `price_change` | product / variant | L2 | `max_price_delta_pct: 20`；`max_items_per_change: 25`；累计 `max_cumulative_delta_pct_30d: 30` | `protected: [sku, currency, tax_category]` |
| `listing_edit` | product | L2 | `requires_record_read: true` | `protected: [listing_id, compliance_notes]` |
| `publish_product` / `unpublish_product` | product | L1 | — | — |
| `promotion` | campaign / price_rule | L2 | `max_promotion_discount_pct: 50`；`margin_floor_pct`（策略层） | margin_after ≥ floor |
| `campaign_send` | email_campaign | L2 | `max_campaign_audience`（策略层） | 受众必须来自分群 id（provenance） |
| `publish_post` | social_post | L2 | `window: N/day` | 含品牌红线词 → block |
| `bid_change` / `budget_change` | ad_set / campaign | L2 | `max_bid_change_pct: 15`；`max_budget_change_pct: 20`；全局 `max_daily_spend_total` | 新开 campaign 永远 L1（`create_campaign` 单列） |
| `create_campaign` | ad_account | L1 | — | — |
| `pause_ad` / `negative_keyword` | ad_set / keyword | **L3** | 止损类 | — |
| `publish_theme` / `merge_pr` / `deploy` | theme / repo / site | **L1 永远** | — | `hard_ceiling` |
| `dns_change` / `payment_config` / `tax_config` / `domain_config` | store_config | **L1 永远** | — | `hard_ceiling`；`protected` 全字段 |
| `staged_action` | 任意 OpenConnector Action | **v1 关闭**（31 §3.2） | — | — |

新增 kind 的规则：写进目录、给 target 类型、给默认 caps、给硬约束、在合成 provider 里有对应的假 executor。

---

## 3. Guardrail 评估

### 3.1 配置解析

```
effective = merge(Role.actions[kind].mandate, WorkspacePolicy.mandates[kind], Assignment.mandate_overrides[kind])
```
Assignment 只能更紧（数值取更小、集合取交集、布尔只能从 false→true 收紧）；违反此规则的配置在写入策略层时就被拒绝。

### 3.2 规则类型

| 类型 | 例子 | 违反的后果 |
|---|---|---|
| 数值上限 `max_*` | 退款金额、价格变动百分比、预算变动 | **require_review**（超额 → L1 人审，不是禁止）；**人批准后为 `approved_exception`，apply 不再因它失败** |
| 频次 `window` | 每天 20 笔自动退款 | require_review |
| 累计 `max_cumulative_*_Nd` | 同一目标 30 天内累计降价 ≤ 30% | require_review（防跨运行分批绕过） |
| 状态条件 | `unfulfilled_only`、`within_policy_window_only`、`paid_only` | **block**（条件不满足就不该提这个变更） |
| 受保护字段 `protected` | 货币、税类、支付配置 | **block（Agent 不得提议）**；人经 `policy_change` 审批项可改 |
| 集合内重复 `no_repeat_target_field` | 同一 change_set 里同一 (target, field) 两次 | **block**（防拆单累加） |
| 关系授权 `authorization_check`（09-08 新增，31 §3.3） | refund / reship / address_change 的请求者必须与目标订单客户身份匹配 | **block** 并转人工核验；provenance 只证明"读过" |
| 改前必读 `requires_record_read` | listing 编辑前必须 get 过全记录 | **block** |
| 最小毛利 `margin_floor_pct` | 促销后毛利 ≥ 32% | require_review |
| 允许列表 `allowlist` | staged_action 的 action_id | block |
| 全局闸 `max_daily_spend_total` | 所有广告账户日花费 | block + 即时通知 owner |

```ts
type GuardrailResult = {
  verdict: 'allow' | 'require_review' | 'block'
  hits: { rule: string; cap?: number | string; actual?: number | string; severity: 'review' | 'block' }[]
  effective_mandate_hash: string            // 用了哪份配置；apply 时比对是否收紧
  evaluated_at: string
}
```

### 3.3 两次评估

| 时机 | 用什么数据 | 结果去哪 |
|---|---|---|
| stage | stage 时读到的记录 + 当时的 effective mandate | `guardrail`；`allow` 且等级 ≥ L2 → 宿主写 approved_change_ids（审批项 auto_approved）；`require_review` → L1 路由；`block` → 不建审批项，运行内告诉模型原因 |
| apply | **重新读目标记录** + **当前**的 effective mandate + **重算执行快照** | `guardrail_rerun`；硬禁令 block → `failed{policy_tightened}`；软额度超出且已 approved → 记 `approved_exception` 继续；快照不一致 → `failed{snapshot_mismatch}` |

---

## 4. 变更集与防绕过

一次运行里 stage 的所有变更属于一个 `change_set`。规则：

1. 集合内同一 `(target, field)` 只允许一次（`no_repeat_target_field`）
2. 集合内同类变更计数受 `max_items_per_change`
3. 跨运行的累计由 `max_cumulative_*_Nd` 管：评估时查该目标最近 N 天 **已 applied + 在途（approved / applying / unknown）+ 预占** 的同 kind 变更求和（09-08 改）
4. 变更请求结束却没有任何 stage（模型只说不做）→ 运行时追加一次提醒（Commerce Agents 的 `STAGING_FOLLOWTHROUGH_REMINDER`），仍不做则记 `no_stage` 事件供健康看板看

---

## 5. Apply（只有执行器能调）

```
apply_change(id):
  0. 已 applied 的 id 再次 apply → 返回原结果（幂等）
  1. 取 StagedChange；status 必须是 approved 或 auto_approved；否则 failed{not_approved}；在 (assignment, kind, day) 预占计数器上核对预占并串行化同目标同 kind 的 apply
  2. 校验 approved_change_ids 含 id（宿主写的，不信任任何别的来源）
  3. 凭 run_id 取 ProvenanceState，确认 target 在 seen 里（apply 时也查，防审批项被篡改）
  4. 重读目标记录；record_version 变了 →
        **任何 kind 一律 failed{stale_record}**（09-08 改：幂等不等于有权覆盖后来的合法修改，评审 F3）
  5. 重跑 Guardrail（§3.3）
  6. Backend.apply_change → connect-adapter.execute(action, input, { idempotencyKey: id })
        OpenConnector 24h 内同键重放 → 不会二次退款
  7. 记 apply{execution_id, outcome_ref}；status=applied；发 change.applied 事件
  8. 失败分三态：明确失败 → failed 并释放预占；retryable（429）→ 同 key 重试 ≤ 3；**超时 / 响应丢失 → `unknown`**：按 execution_id / 平台对象查询确认，确认不了 → 人工对账项；备份恢复后先跑对账再放开出站
```

**反向变更**：`price_change`、`address_change`、`publish_*`、`pause_ad` 等可逆 kind，applied 后可生成 `reversal_of` 变更走同一流程；`refund`、`reship`、`campaign_send` 不可逆，界面上不提供"撤销"，只提供"反向操作需另提"。

---

## 6. ProvenanceState

```ts
type ProvenanceState = {
  run_id: string
  seen: Record<ObjectType, Set<string>>      // 每类 ≤ 200，超出按 LRU 淘汰并记事件
  read_full: Set<string>                     // requires_record_read 用：get 过全记录的 id
  recorded_at: string
}
```

- 读处理器（工具 post-execute）负责写入：任何工具结果里出现的实体 id 进 `seen`；`get_*` 全记录进 `read_full`
- 写（stage）与呈现（present）前检查：目标 / 收件人 / 引用的事实卡不在 `seen` → block，理由"本次运行未读取过该对象"
- 随运行结果持久化到共享数据层（无状态运行下 apply 可能在数小时后）
- 上限 200 是 Commerce Agents 的值，v1 沿用

---

## 7. API 与事件

| 方法 | 路径 | 谁调 |
|---|---|---|
| POST | `/changes/stage` | 只有执行器（运行内 Backend.stage_*） |
| GET | `/changes?target=&kind=&status=&run=` | 队列、审计、累计评估 |
| GET | `/changes/{id}` | 详情（含两次 guardrail） |
| POST | `/changes/{id}/approve` | 只有审批总线（内部） |
| POST | `/changes/{id}/apply` | 只有执行器 |
| POST | `/changes/{id}/withdraw` | 提议者，staged 时 |
| POST | `/changes/{id}/reverse` | 可逆 kind，生成反向 StagedChange |
| POST | `/guardrails/evaluate` | 预检、模拟、界面预览（只评估不 stage） |

事件：`change.staged`、`.blocked`、`.approved`、`.applying`、`.applied`、`.failed`、`.expired`、`.withdrawn`、`.superseded`、`.reversed`、`guardrail.hit`（每次命中一条，健康看板与降级用）。

---

## 8. 一致性用例

0. 隐藏恶意场景：陌生人邮件声称订单归自己 → 合法 get_order → seen 命中 → 要求补发到新地址 → `authorization_check` block，转人工核验（评审 §5）

1. Backend 接口里不存在任何非 `stage_*` 的写方法（静态检查）
2. `after` 里的金额来自模型、`before` 来自记录：篡改 `before` 的 stage 请求被拒
3. 同一 change_set 内两次 `price_change` 同一 variant → 第二次 block
4. 两次运行各降价 20%（各自 allow）→ 第二次累计 40% > 30% → require_review
5. 退款 $40 额度 $50：L1 → 路由；L2 → auto_approved；等级由 Assignment 决定
6. stage 后策略层把 `max_auto_refund_amount` 改成 30 → apply 时 `policy_tightened`
7. stage 后订单已发货 → `address_change` apply 时 `stale_record`
8. 同 id apply 两次 → 第二次返回第一次结果（本地步骤 0 + OpenConnector 幂等），无二次退款
9. target 不在 provenance → stage 被 block；把 seen 篡改后 apply → 仍 block（apply 时重查）
10. `publish_theme` 无论等级配置多高都 L1（hard_ceiling）
11. 多币种：店铺 EUR 退款 €45 换算基准 USD 后与 cap 比较，fx 快照记录
12. `pause_ad` 在 L3 下仍建审批记录（auto_approved，不进人的待办）并 apply，留 StagedChange 与事件（与 14 一致）
13. 模拟：合成 provider 注入 429 → 自动重试 3 次后 failed{retryable}，审批项 apply_failed

---

## 9. 示例

```yaml
id: chg_12
kind: refund
role_id: dtc.aftersales
assignment_id: asg_3
run_id: run_5
change_set_id: cs_5
target: { type: order, id: ord_1042 }
before: { refunded: 0, total: 89.00, currency: USD, fulfillment: delivered, delivered_at: 2026-09-02 }
after: { refund_amount: 42.00, reason: "return within window" }
record_version: "2026-09-08T01:12:00Z"
money: { amount: 42.00, currency: USD, amount_base: 42.00, base_currency: USD, fx_rate: 1, fx_at: 2026-09-08T09:00:00Z }
guardrail:
  verdict: allow
  hits: []
  effective_mandate_hash: "m:8f3a…"
  evaluated_at: 2026-09-08T09:00:02Z
created_by: { kind: agent, id: agent_aftersales }
status: staged
expires_at: 2026-09-10T09:00:00+08:00
```

---

## 10. 待拍板

1. 工作区基准货币默认 USD，可改；fx 来源（网关内置汇率 provider）
2. 累计窗口默认 30 天、累计上限 = 单次上限 × 1.5
3. `stale_record` 对可幂等 kind 默认继续、不可幂等 kind 默认失败（如上）
4. provenance 上限 200 / 类
