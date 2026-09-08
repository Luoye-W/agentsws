# 职责 Schema v1

| | |
|---|---|
| 日期 | 2026-09-07 |
| 状态 | 讨论稿。对应 03 文档 §2.1；04 文档的所有职责都要能用这个 schema 表达 |
| 存放 | 职责定义是配置不是数据：放内容仓 `roles/<domain>/<id>.yml`，有版本、走审批；分配关系放数据库 |

---

## 0. 对象关系一览

```
Position（岗位模板）──默认包含──▶ Role（职责定义，版本化）
                                   │
Person ──Assignment（分配：人 × 职责 × 工作区 × 范围）──┘
                                   │
                          EffectiveConfig（并集计算，运行时）
                                   │
                    WorkItem（每个工作项打一个 role_id，决定路由与额度）
```

四条不变量：

1. Role 定义不含任何公司特定数字；公司的额度在 `WorkspacePolicy` 里覆盖（商业策略层，只有 owner 能改）
2. Assignment 只能把额度改**更紧**，不能放宽
3. 每个 WorkItem 有且只有一个 `role_id`；跨职责的东西是两个工作项互相引用
4. 自动化等级的当前状态挂在 Assignment 上（是这个人这个职责的信任数据），上限挂在 Role 上

---

## 1. Role（职责定义）

```ts
type Role = {
  id: string                 // '<domain>.<slug>'，如 'dtc.aftersales'；店铺、账号不进 id，走 range
  version: string            // semver；破坏性字段变更升 major
  domain: 'dtc' | 'amz' | 'social' | 'kol' | 'ads' | 'design' | 'common'
  name: { zh: string; en: string }
  description: string        // 一句话，给分配职责的管理者看

  scopes: PermissionScope[]          // 权限作用域（四件套 1）
  home_blocks: HomeBlock[]           // 首页积木（四件套 2）
  skills: SkillRef[]                 // 技能包（四件套 3）
  notifications: NotificationRule[] // 通知路由（四件套 4）

  connectors: ConnectorDependency[]  // 三项约束 1：连接器依赖
  actions: WriteAction[]             // 三项约束 2：允许 stage 的写操作与额度
  automation: Record<ActionId, AutomationSpec>  // 三项约束 3：每个动作的自动化上限

  grounding?: GroundingRule[]        // 某类问题必须先读工具
  persona?: string                   // 覆盖 dsh 的 deployment:persona 分节
  handover: HandoverSpec             // 交接时转移什么
  requires?: string[]                // 隐含依赖的职责 id（只借其 read scopes，不借写）
}
```

### 1.1 PermissionScope

对应架构总览的"角色 × 数据域 × 操作 × 范围"，外加字段分级。

```ts
type DataDomain =
  | 'customer' | 'order' | 'shipment' | 'product' | 'inventory' | 'store_config'
  | 'content' | 'discount' | 'campaign' | 'analytics' | 'asset' | 'knowledge'
  | 'creator' | 'ad_account' | 'social_account' | 'review' | 'finance'
  | 'approval' | 'skill' | 'policy' | 'event_log'

type Operation =
  | 'read'
  | 'stage'          // 提议变更，进账本
  | 'approve'        // 批准别人（或 Agent）的 staged change
  | 'agent_auto'     // "授权 Agent 代做"：额度内由宿主自动写 approved_change_ids

type Range =
  | 'own'            // 自己创建 / 被分配的记录
  | 'assigned'       // Assignment 上指定的范围集合（店铺、部门、账号）
  | 'workspace'      // 整个工作区

type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted'

type PermissionScope = {
  domain: DataDomain
  ops: Operation[]
  range: Range
  max_sensitivity: Sensitivity      // 这个职责的人最多能看到哪一级字段
  // agent_max_sensitivity 已于 09-08 撤销（31 §3.3）：v1 Agent 不持有高于 actor 的读权限
}
```

字段分级由数据域的 schema 决定（如 `product.cost_price = confidential`），不在职责里重复声明；职责只声明"最多看到哪级"。

### 1.2 ConnectorDependency

```ts
type ConnectorDependency = {
  kind: 'shopify' | 'email' | 'live_chat' | 'tracking' | 'payment_dispute'
      | 'meta' | 'tiktok' | 'youtube' | 'pinterest' | 'x'
      | 'google_ads' | 'merchant_center' | 'meta_ads' | 'tiktok_ads' | 'amazon_ads'
      | 'amazon_sp' | 'klaviyo' | 'reviews' | 'ga4' | 'gsc' | 'asset_store' | 'feishu' | string
  required: boolean               // false = 缺了职责也能用，只是某些积木灰掉
  grants: string[]                // 需要的最小授权范围（provider 原生 scope 名）
  ownership: 'workspace' | 'person'  // 公司资产 vs 个人身份；Join 时前者转移、后者留本机
}
```

### 1.3 WriteAction 与额度（Mandate）

```ts
type WriteAction = {
  id: ActionId                    // 'stage_refund'
  target: DataDomain              // 'order'
  kind: 'staged_change' | 'outbound_message' | 'publish' | 'config_change'
  mandate: Mandate                // 额度：默认值在 Role，公司覆盖在 WorkspacePolicy
  requires_record_read?: boolean  // 改前必读（Commerce Agents 的 record-read gate）
  protected_fields?: string[]     // 此动作永远不能碰的字段
  review_cannot_be_disabled?: boolean  // 超额人审不可关闭（价格 / 交期 / 合同承诺、支付、域名）
  route_to: 'role_holder' | 'scope_manager' | 'owner' | { role: string }  // 审批项路由
}

type Mandate = {
  caps: Record<string, number | string[]>   // 如 { max_auto_refund_amount: 50, currency: 'USD' }
  per_change_limits?: { max_items?: number; no_repeat_target_field?: boolean }
  window?: { max_count: number; per: 'day' | 'week' }   // 频次上限
}
```

写操作只描述"能 stage 什么"和"额度内能自动到哪"。真正的 apply 永远由执行器做，apply 时重跑 mandate。

### 1.4 AutomationSpec

```ts
type Level = 'L1' | 'L2' | 'L3'

type AutomationSpec = {
  ceiling: Level               // 最高能到哪
  initial: Level               // 新分配时从哪起（默认 L1）
  hard_ceiling?: boolean       // true = 任何配置不得突破 ceiling（LinkedIn 发送、支付配置）
  promotion: {
    adoption_rate_min: number  // 默认 0.95：草稿未修改直接通过的比例
    window_weeks: number       // 默认 4
    min_samples: number        // 默认 30；样本不够不晋级
  }
  demotion_triggers: ('customer_complaint' | 'guardrail_hit' | 'manual')[]  // 触发即降一级并通知
}
```

采纳率、样本数、当前等级都记在 Assignment 上；Role 只给规则。

### 1.5 SkillRef

```ts
type SkillRef = {
  name: string                 // 'customer-care'
  min_version?: string
  tier: 'open' | 'premium'     // premium 由付费插件提供同名高级版本；未安装时回退 open
  load: 'always' | 'on_demand' // on_demand = 只有索引行进 prompt，模型按需 load_skill
}
```

### 1.6 HomeBlock

```ts
type HomeBlock = {
  id: string                   // 'aftersales.pending_replies'
  placement: 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
                               // 首页只有 queue/alert/focus/digest 四区且形状固定；role_view 只在职责工作面（见 06 文档 §1）
  component: string            // 前端注册表里的组件名（积木 = 工具契约 + payload schema + enrichment + 注册表）
  query: string                // 数据查询的命名引用，由服务端执行并 enrichment，前端不拼查询
  default_order: number
  pinnable: boolean            // 个人可钉住 / 隐藏
  adaptive: boolean            // 自适应层是否允许调它的排序
}
```

### 1.7 NotificationRule

```ts
type NotificationRule = {
  event: string                // 事件模式，如 'order.overdue' | 'approval.created:stage_refund' | 'customer.complaint'
  mode: 'immediate' | 'queue' | 'digest'
  recipients: ('role_holder' | 'scope_manager' | 'owner')[]
  escalate_after_hours?: number   // 队列里无人处理则升级到下一层
  digest_schedule?: string        // cron，digest 模式用
}
```

### 1.8 GroundingRule

```ts
type GroundingRule = {
  name: string
  intent_terms: string[]       // 意图词
  cue_terms: string[]          // 线索词；两者同时命中才触发
  tool: string                 // 必须先调的工具
  prefetch: boolean            // 运行时不支持强制 tool_choice 时由宿主预取
}
```

### 1.9 HandoverSpec

```ts
type HandoverSpec = {
  transfers: ('open_work_items' | 'context' | 'home_blocks' | 'queue_lane')[]
  fallback: 'owner' | 'scope_manager'   // 无接手人时挂给谁
  revoke_context_on_removal: boolean    // 撤销职责时收回该职责的上下文访问
}
```

---

## 2. Position（岗位模板）

```ts
type Position = {
  id: string                   // 'dtc-ops' | 'amazon-ops' | 'social' | 'kol' | 'ads' | 'design'
  name: { zh: string; en: string }
  roles: { role: string; default: boolean }[]   // default=false 的是可勾选项
  version: string
}
```

岗位模板只在分配那一刻展开成一组 Assignment；之后改模板不影响已分配的人，"重新应用模板"需确认。

---

## 3. Assignment（分配）与 WorkspacePolicy

```ts
type Assignment = {
  id: string
  person_id: string            // 全局身份，不绑工作区
  workspace_id: string
  role_id: string
  role_version: string         // 分配时的版本；Role 升 major 后提示重新确认
  ranges: RangeRef[]           // [{kind:'store', id:'shop_a'}, {kind:'department', id:'ops'}]
  mandate_overrides?: Partial<Mandate>        // 只能更紧
  automation_state: Record<ActionId, {
    level: Level
    adoption: { accepted: number; edited: number; rejected: number; since: string }
    last_change: { at: string; reason: string }
  }>
  granted_by: string
  granted_at: string
  revoked_at?: string
  handover_to?: string         // 撤销时的接手人
}

type WorkspacePolicy = {       // 商业策略层：只有 owner 可改，Agent 只引用不推断
  workspace_id: string
  mandates: Record<ActionId, Partial<Mandate>>   // 覆盖 Role 的默认额度（可松可紧）
  global_caps: Record<string, number>            // 如 max_daily_spend_total
  sensitivity_overrides?: Record<string, Sensitivity>  // 某字段在本公司升 / 降级
  separation_of_duties?: ActionId[]              // 标"须他人审批"的动作；无人可替时升级 owner 并留痕
}
```

额度解析顺序：`Role.mandate` → `WorkspacePolicy.mandates` 覆盖 → `Assignment.mandate_overrides` 收紧。

---

## 4. EffectiveConfig（运行时并集）

给定 `(person, workspace)`：

| 项 | 规则 |
|---|---|
| scopes | **不并集**（09-08 改，31 §3.1）：每次运行绑定一个 Assignment，其 scopes 原样生效；数据层按 (domain, ops, range, sensitivity) 完整元组判定，任一维不满足即拒；空 range 的 Assignment 拒签 token、查询为空 |
| connectors | 并集；`required` 缺失的职责标"未就绪"，其积木灰掉，队列车道不产生工作项 |
| actions | 并集；**额度按工作项的 `role_id` 解析**，不取最大 |
| automation | 按 `(role_id, action_id)` 查该 Assignment 的当前等级；**采纳率只是体验指标**，自动执行由 ChangeKind.risk_class + 结果核验 + 版本指纹决定（31 §3.4）；v1 只有 low 风险可 L2 |
| home_blocks | 按 placement 合并：queue 合成一条队列、alert 合成一条告警条、focus 竞争最多 6 个位置、digest 进一份日报；role_view 不进首页。个人钉住 / 隐藏永远优先；自适应只动未钉住区，一天最多一次并说明原因 |
| queue | 一条队列；每个工作项带 `role_id` 标签；排序 = 紧急度 × 等待时长 × 通知模式 |
| notifications | 并集；同一事件多条规则取最急的 mode |
| skills | 并集；同名 premium 覆盖 open |
| persona | 多职责时取"公司标准 + 当前工作项职责"的 persona，不拼接 |

给 Agent 的运行请求（03 文档 §1.2 的 RunRequest）从 EffectiveConfig 派生：以谁的身份、这个工作项的 role_id、该职责的工具集（`ctx.tools.restrict`）、该职责的 skills、该职责的 grounding 规则、该动作的 mandate。

---

## 5. 完整示例：`dtc.aftersales`

```yaml
id: dtc.aftersales
version: 1.0.0
domain: dtc
name: { zh: 独立站售后客服, en: DTC After-sales Support }
description: 订单状态与物流、退换货、退款、改地址、漏发错发破损、拒付争议

scopes:
  - { domain: order,     ops: [read],          range: assigned, max_sensitivity: internal }
  - { domain: shipment,  ops: [read],          range: assigned, max_sensitivity: internal }
  - { domain: customer,  ops: [read, stage],   range: assigned, max_sensitivity: internal,
      agent_max_sensitivity: confidential }   # Agent 可看客户私人联系方式以核对身份，回复里不回显
  - { domain: knowledge, ops: [read],          range: workspace, max_sensitivity: internal }
  - { domain: discount,  ops: [stage],         range: assigned, max_sensitivity: internal }
  - { domain: approval,  ops: [read, approve], range: own,      max_sensitivity: internal }

connectors:
  - { kind: email,           required: true,  grants: [mail.read, mail.send],      ownership: workspace }
  - { kind: shopify,         required: true,  grants: [read_orders, write_orders, read_fulfillments], ownership: workspace }
  - { kind: tracking,        required: false, grants: [read],                      ownership: workspace }
  - { kind: payment_dispute, required: false, grants: [disputes.read],             ownership: workspace }

actions:
  - id: reply_customer
    target: customer
    kind: outbound_message
    mandate: { caps: {}, window: { max_count: 200, per: day } }
    route_to: role_holder
  - id: stage_refund
    target: order
    kind: staged_change
    requires_record_read: true
    mandate:
      caps: { max_auto_refund_amount: 50, currency: USD, within_policy_window_only: true }
      per_change_limits: { max_items: 1, no_repeat_target_field: true }
      window: { max_count: 20, per: day }
    review_cannot_be_disabled: true
    route_to: scope_manager
  - id: stage_reship
    target: order
    kind: staged_change
    requires_record_read: true
    mandate: { caps: { max_items_per_order: 1 }, window: { max_count: 10, per: day } }
    review_cannot_be_disabled: true
    route_to: scope_manager
  - id: stage_address_change
    target: order
    kind: staged_change
    requires_record_read: true
    mandate: { caps: { unfulfilled_only: true } }
    protected_fields: [order.total, order.currency, order.customer_id]
    route_to: role_holder
  - id: draft_chargeback_evidence
    target: finance
    kind: staged_change
    mandate: { caps: {} }
    route_to: owner

automation:
  reply_customer:            { ceiling: L3, initial: L1, promotion: { adoption_rate_min: 0.95, window_weeks: 4, min_samples: 30 }, demotion_triggers: [customer_complaint, guardrail_hit, manual] }
  stage_refund:              { ceiling: L2, initial: L1, promotion: { adoption_rate_min: 0.95, window_weeks: 4, min_samples: 30 }, demotion_triggers: [guardrail_hit, manual] }
  stage_reship:              { ceiling: L2, initial: L1, promotion: { adoption_rate_min: 0.95, window_weeks: 4, min_samples: 20 }, demotion_triggers: [guardrail_hit, manual] }
  stage_address_change:      { ceiling: L2, initial: L1, promotion: { adoption_rate_min: 0.95, window_weeks: 4, min_samples: 20 }, demotion_triggers: [manual] }
  draft_chargeback_evidence: { ceiling: L1, initial: L1, hard_ceiling: true, promotion: { adoption_rate_min: 1, window_weeks: 0, min_samples: 0 }, demotion_triggers: [manual] }

grounding:
  - { name: order_status, intent_terms: [订单, order, 包裹, package], cue_terms: [哪, where, 什么时候, when, 到了, arrived], tool: get_order, prefetch: true }
  - { name: policy,       intent_terms: [退, return, refund, 换, exchange], cue_terms: [可以, can, 能, 政策, policy], tool: search_policies, prefetch: true }

skills:
  - { name: customer-care,        tier: open, load: always }
  - { name: returns-policy-calc,  tier: open, load: on_demand }
  - { name: chargeback-evidence,  tier: open, load: on_demand }

home_blocks:
  - { id: aftersales.pending_replies, placement: queue, component: approval_lane, query: approvals.by_role(dtc.aftersales, reply_customer), default_order: 10, pinnable: true, adaptive: true }
  - { id: aftersales.pending_refunds, placement: queue, component: staged_change_list, query: changes.pending(dtc.aftersales), default_order: 20, pinnable: true, adaptive: true }
  - { id: aftersales.overdue_orders,  placement: focus, component: order_table, query: orders.overdue(assigned), default_order: 30, pinnable: true, adaptive: true }
  - { id: aftersales.escalations,     placement: alert, component: alert_list, query: events.escalations(dtc.aftersales), default_order: 5, pinnable: false, adaptive: false }

notifications:
  - { event: customer.complaint,                 mode: immediate, recipients: [role_holder, scope_manager] }
  - { event: payment.dispute_opened,             mode: immediate, recipients: [role_holder, owner] }
  - { event: approval.created:stage_refund,      mode: queue,     recipients: [scope_manager], escalate_after_hours: 24 }
  - { event: approval.created:reply_customer,    mode: queue,     recipients: [role_holder],   escalate_after_hours: 8 }
  - { event: order.overdue,                      mode: digest,    recipients: [role_holder],   digest_schedule: '0 9 * * *' }

handover:
  transfers: [open_work_items, context, home_blocks, queue_lane]
  fallback: scope_manager
  revoke_context_on_removal: true

requires: []
```

---

## 6. 与其他规范的接口

| 对象 | 由谁消费 |
|---|---|
| `scopes` | 数据层 ACL（检索必须带身份）与输出侧脱敏 |
| `actions.mandate` | 执行器的 guardrail（stage 时与 apply 时各跑一次） |
| `automation` | 审批总线：L2/L3 = 宿主在额度内自动写 approved_change_ids，仍过同一个 gate |
| `home_blocks` | 工作台前端注册表 |
| `notifications` | 审批投递 provider（飞书卡片 / 企微 / 邮件） |
| `connectors` | Join 时的所有权转移清单；`agentsws doctor` 的就绪检查 |
| `grounding` / `skills` / `persona` | dsh-adapter 组装 RunRequest |

---

## 7. 待定

1. `Range` 的种类清单：店铺、部门、平台账号、市场（国家）——是否够；多店铺公司每店一个 range 还是店铺组
2. 额度里的金额要不要统一换算成工作区基准货币（我倾向要，多币种店铺否则没法比）
3. 采纳率的"编辑"怎么算：改一个标点算不算修改——建议按语义 diff 阈值，具体阈值等有数据
4. Role 定义走审批的粒度：改默认额度算策略变更（owner），改积木顺序算首页调整——要不要分两条审批类型
